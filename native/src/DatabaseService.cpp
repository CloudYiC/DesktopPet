#include "Milo/DatabaseService.h"

#include <windows.h>
#include <sqlite3.h>

#include <chrono>
#include <cctype>
#include <sstream>
#include <stdexcept>

#include "Milo/Utils.h"

namespace milo {
namespace {

const std::size_t kMaximumSqlBytes = 256U * 1024U;
const std::size_t kMaximumResultRows = 500U;

class ScopedDatabase final {
 public:
  explicit ScopedDatabase(sqlite3* value) : value_(value) {}
  ~ScopedDatabase() {
    if (value_ != nullptr) sqlite3_close(value_);
  }
  sqlite3* get() const { return value_; }

 private:
  sqlite3* value_{};
};

class ScopedStatement final {
 public:
  explicit ScopedStatement(sqlite3_stmt* value) : value_(value) {}
  ~ScopedStatement() {
    if (value_ != nullptr) sqlite3_finalize(value_);
  }
  sqlite3_stmt* get() const { return value_; }

 private:
  sqlite3_stmt* value_{};
};

std::runtime_error DatabaseError(sqlite3* database,
                                 const std::string& prefix) {
  const char* detail = database != nullptr ? sqlite3_errmsg(database) : nullptr;
  return std::runtime_error(prefix + (detail ? ": " + std::string(detail) : ""));
}

sqlite3* OpenDatabase(const std::wstring& path, int flags) {
  sqlite3* database = nullptr;
  const std::string utf8Path = WideToUtf8(path);
  const int result = sqlite3_open_v2(utf8Path.c_str(), &database, flags, nullptr);
  if (result != SQLITE_OK) {
    const std::runtime_error error = DatabaseError(database, "无法打开 SQLite 数据库");
    if (database != nullptr) sqlite3_close(database);
    throw error;
  }
  sqlite3_busy_timeout(database, 2500);
  return database;
}

std::string FileNameFromPath(const std::wstring& path) {
  const std::wstring::size_type separator = path.find_last_of(L"\\/");
  return WideToUtf8(separator == std::wstring::npos
                        ? path
                        : path.substr(separator + 1));
}

std::uint64_t FileSize(const std::wstring& path) {
  WIN32_FILE_ATTRIBUTE_DATA attributes{};
  if (!GetFileAttributesExW(path.c_str(), GetFileExInfoStandard, &attributes)) {
    return 0;
  }
  ULARGE_INTEGER size{};
  size.HighPart = attributes.nFileSizeHigh;
  size.LowPart = attributes.nFileSizeLow;
  return size.QuadPart;
}

std::string TextColumn(sqlite3_stmt* statement, int column) {
  const unsigned char* value = sqlite3_column_text(statement, column);
  if (value == nullptr) return {};
  const int bytes = sqlite3_column_bytes(statement, column);
  return std::string(reinterpret_cast<const char*>(value),
                     static_cast<std::size_t>(bytes));
}

std::string QuoteIdentifier(const std::string& identifier) {
  std::string result = "\"";
  for (std::string::const_iterator character = identifier.begin();
       character != identifier.end(); ++character) {
    if (*character == '"') result.push_back('"');
    result.push_back(*character);
  }
  result.push_back('"');
  return result;
}

std::int64_t ReadIntegerPragma(sqlite3* database, const char* name) {
  const std::string sql = "PRAGMA " + std::string(name) + ";";
  sqlite3_stmt* rawStatement = nullptr;
  if (sqlite3_prepare_v2(database, sql.c_str(), -1, &rawStatement, nullptr) !=
      SQLITE_OK) {
    return 0;
  }
  ScopedStatement statement(rawStatement);
  return sqlite3_step(statement.get()) == SQLITE_ROW
             ? sqlite3_column_int64(statement.get(), 0)
             : 0;
}

std::string ReadTextPragma(sqlite3* database, const char* name) {
  const std::string sql = "PRAGMA " + std::string(name) + ";";
  sqlite3_stmt* rawStatement = nullptr;
  if (sqlite3_prepare_v2(database, sql.c_str(), -1, &rawStatement, nullptr) !=
      SQLITE_OK) {
    return {};
  }
  ScopedStatement statement(rawStatement);
  return sqlite3_step(statement.get()) == SQLITE_ROW
             ? TextColumn(statement.get(), 0)
             : std::string{};
}

std::vector<DatabaseColumn> ReadColumns(sqlite3* database,
                                        const std::string& objectName) {
  const std::string sql =
      "PRAGMA table_info(" + QuoteIdentifier(objectName) + ");";
  sqlite3_stmt* rawStatement = nullptr;
  if (sqlite3_prepare_v2(database, sql.c_str(), -1, &rawStatement, nullptr) !=
      SQLITE_OK) {
    return {};
  }
  ScopedStatement statement(rawStatement);
  std::vector<DatabaseColumn> columns;
  int result = SQLITE_ROW;
  while ((result = sqlite3_step(statement.get())) == SQLITE_ROW) {
    DatabaseColumn column;
    column.name = TextColumn(statement.get(), 1);
    column.type = TextColumn(statement.get(), 2);
    column.notNull = sqlite3_column_int(statement.get(), 3) != 0;
    column.defaultValue = TextColumn(statement.get(), 4);
    column.primaryKey = sqlite3_column_int(statement.get(), 5) != 0;
    columns.push_back(column);
  }
  return columns;
}

DatabaseOverview InspectOpenDatabase(sqlite3* database,
                                     const std::wstring& path) {
  DatabaseOverview overview;
  overview.path = WideToUtf8(path);
  overview.fileName = FileNameFromPath(path);
  overview.fileSizeBytes = FileSize(path);
  overview.pageSize = ReadIntegerPragma(database, "page_size");
  overview.pageCount = ReadIntegerPragma(database, "page_count");
  overview.userVersion = ReadIntegerPragma(database, "user_version");
  overview.journalMode = ReadTextPragma(database, "journal_mode");

  const char* sql =
      "SELECT type, name, tbl_name, COALESCE(sql, '') "
      "FROM sqlite_master "
      "WHERE type IN ('table', 'view', 'index', 'trigger') "
      "AND name NOT LIKE 'sqlite_%' "
      "ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1 "
      "WHEN 'index' THEN 2 ELSE 3 END, name COLLATE NOCASE;";
  sqlite3_stmt* rawStatement = nullptr;
  if (sqlite3_prepare_v2(database, sql, -1, &rawStatement, nullptr) !=
      SQLITE_OK) {
    throw DatabaseError(database, "无法读取数据库结构");
  }
  ScopedStatement statement(rawStatement);
  int result = SQLITE_ROW;
  while ((result = sqlite3_step(statement.get())) == SQLITE_ROW) {
    DatabaseObject object;
    object.type = TextColumn(statement.get(), 0);
    object.name = TextColumn(statement.get(), 1);
    object.tableName = TextColumn(statement.get(), 2);
    object.sql = TextColumn(statement.get(), 3);
    if (object.type == "table" || object.type == "view") {
      object.columns = ReadColumns(database, object.name);
    }
    overview.objects.push_back(object);
  }
  if (result != SQLITE_DONE) {
    throw DatabaseError(database, "读取数据库结构时发生错误");
  }
  return overview;
}

bool HasVisibleSql(const std::string& sql) {
  for (std::string::const_iterator character = sql.begin();
       character != sql.end(); ++character) {
    if (!std::isspace(static_cast<unsigned char>(*character))) return true;
  }
  return false;
}

std::string ResultCell(sqlite3_stmt* statement, int column) {
  switch (sqlite3_column_type(statement, column)) {
    case SQLITE_NULL:
      return "NULL";
    case SQLITE_INTEGER:
      return std::to_string(sqlite3_column_int64(statement, column));
    case SQLITE_FLOAT: {
      std::ostringstream text;
      text.precision(15);
      text << sqlite3_column_double(statement, column);
      return text.str();
    }
    case SQLITE_BLOB:
      return "<BLOB " + std::to_string(sqlite3_column_bytes(statement, column)) +
             " bytes>";
    default:
      return TextColumn(statement, column);
  }
}

}  // namespace

DatabaseOverview CreateDatabase(const std::wstring& path) {
  if (path.empty()) throw std::runtime_error("数据库路径不能为空。");
  ScopedDatabase database(OpenDatabase(
      path, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX));
  return InspectOpenDatabase(database.get(), path);
}

DatabaseOverview InspectDatabase(const std::wstring& path) {
  if (path.empty()) throw std::runtime_error("请先选择 SQLite 数据库。");
  const DWORD attributes = GetFileAttributesW(path.c_str());
  if (attributes == INVALID_FILE_ATTRIBUTES ||
      (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
    throw std::runtime_error("选择的数据库文件不存在或不是普通文件。");
  }
  ScopedDatabase database(
      OpenDatabase(path, SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX));
  return InspectOpenDatabase(database.get(), path);
}

DatabaseQueryResult ExecuteDatabaseSql(const std::wstring& path,
                                       const std::string& sql,
                                       bool allowWrite) {
  if (path.empty()) throw std::runtime_error("请先打开一个 SQLite 数据库。");
  if (!HasVisibleSql(sql)) throw std::runtime_error("请输入要执行的 SQL。");
  if (sql.size() > kMaximumSqlBytes) {
    throw std::runtime_error("单次 SQL 不能超过 256 KB。");
  }

  const int flags = (allowWrite ? SQLITE_OPEN_READWRITE : SQLITE_OPEN_READONLY) |
                    SQLITE_OPEN_FULLMUTEX;
  ScopedDatabase database(OpenDatabase(path, flags));
  DatabaseQueryResult output;
  const sqlite3_int64 changesBefore = sqlite3_total_changes64(database.get());
  const std::chrono::steady_clock::time_point started =
      std::chrono::steady_clock::now();
  const char* cursor = sql.c_str();

  while (cursor != nullptr && *cursor != '\0') {
    sqlite3_stmt* rawStatement = nullptr;
    const char* tail = nullptr;
    const int prepared = sqlite3_prepare_v2(database.get(), cursor, -1,
                                            &rawStatement, &tail);
    if (prepared != SQLITE_OK) {
      throw DatabaseError(database.get(), "SQL 解析失败");
    }
    if (tail == cursor) {
      if (rawStatement != nullptr) sqlite3_finalize(rawStatement);
      break;
    }
    cursor = tail;
    if (rawStatement == nullptr) continue;
    ScopedStatement statement(rawStatement);
    const bool readOnly = sqlite3_stmt_readonly(statement.get()) != 0;
    if (!readOnly && !allowWrite) {
      throw std::runtime_error(
          "当前处于只读模式；如需修改数据库，请先明确启用“允许写入”。");
    }
    output.wroteData = output.wroteData || !readOnly;
    ++output.statementCount;

    const int columnCount = sqlite3_column_count(statement.get());
    // The UI reports the final statement. Clear an earlier SELECT result when
    // the final statement is a write or schema operation with no result set.
    output.columns.clear();
    output.rows.clear();
    output.truncated = false;
    if (columnCount > 0) {
      for (int column = 0; column < columnCount; ++column) {
        const char* name = sqlite3_column_name(statement.get(), column);
        output.columns.push_back(name ? name : "");
      }
    }

    int stepped = SQLITE_ROW;
    while ((stepped = sqlite3_step(statement.get())) == SQLITE_ROW) {
      if (output.rows.size() < kMaximumResultRows) {
        std::vector<std::string> row;
        row.reserve(static_cast<std::size_t>(columnCount));
        for (int column = 0; column < columnCount; ++column) {
          row.push_back(ResultCell(statement.get(), column));
        }
        output.rows.push_back(row);
      } else {
        output.truncated = true;
        if (readOnly) break;
      }
    }
    if (stepped != SQLITE_DONE && !(readOnly && output.truncated)) {
      throw DatabaseError(database.get(), "SQL 执行失败");
    }
  }

  if (output.statementCount == 0) {
    throw std::runtime_error("没有找到可执行的 SQL 语句。");
  }
  output.affectedRows =
      sqlite3_total_changes64(database.get()) - changesBefore;
  output.lastInsertId = sqlite3_last_insert_rowid(database.get());
  output.elapsedMilliseconds = static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now() - started)
          .count());
  if (!output.columns.empty()) {
    output.message = "查询完成，返回 " + std::to_string(output.rows.size()) +
                     (output.truncated ? " 行（结果已截断）。" : " 行。");
  } else {
    output.message = "执行完成，影响 " + std::to_string(output.affectedRows) +
                     " 行。";
  }
  return output;
}

}  // namespace milo
