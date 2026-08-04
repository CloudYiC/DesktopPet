#pragma once

/// @file
/// @brief SQLite database inspection and permission-gated SQL execution.

#include <cstdint>
#include <string>
#include <vector>

namespace milo {

struct DatabaseColumn {
  std::string name;
  std::string type;
  std::string defaultValue;
  bool notNull{};
  bool primaryKey{};
};

struct DatabaseObject {
  std::string type;
  std::string name;
  std::string tableName;
  std::string sql;
  std::vector<DatabaseColumn> columns;
};

struct DatabaseOverview {
  std::string path;
  std::string fileName;
  std::uint64_t fileSizeBytes{};
  std::int64_t pageSize{};
  std::int64_t pageCount{};
  std::int64_t userVersion{};
  std::string journalMode;
  std::vector<DatabaseObject> objects;
};

struct DatabaseQueryResult {
  std::vector<std::string> columns;
  std::vector<std::vector<std::string>> rows;
  std::int64_t affectedRows{};
  std::int64_t lastInsertId{};
  std::uint64_t elapsedMilliseconds{};
  std::uint32_t statementCount{};
  bool truncated{};
  bool wroteData{};
  std::string message;
};

/// Creates an empty SQLite file when necessary and returns its schema summary.
DatabaseOverview CreateDatabase(const std::wstring& path);

/// Opens an existing SQLite database in read-only mode and inspects its schema.
DatabaseOverview InspectDatabase(const std::wstring& path);

/**
 * Executes one or more SQLite statements. Non-read-only statements are
 * rejected unless `allowWrite` is true. At most 500 result rows are returned.
 */
DatabaseQueryResult ExecuteDatabaseSql(const std::wstring& path,
                                       const std::string& sql,
                                       bool allowWrite);

}  // namespace milo
