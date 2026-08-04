#include <windows.h>

#include <iostream>
#include <stdexcept>
#include <string>

#include "Milo/DatabaseService.h"
#include "Milo/Utils.h"

namespace {

void Expect(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

std::wstring TestDatabasePath() {
  wchar_t temporaryDirectory[MAX_PATH]{};
  const DWORD length = GetTempPathW(ARRAYSIZE(temporaryDirectory),
                                    temporaryDirectory);
  if (length == 0 || length >= ARRAYSIZE(temporaryDirectory)) {
    throw std::runtime_error("Unable to locate the temporary directory.");
  }
  const std::wstring unique = std::to_wstring(GetCurrentProcessId()) + L"-" +
                              std::to_wstring(milo::UnixTimeMilliseconds());
  return milo::JoinPath(temporaryDirectory,
                        L"yiyi-database-studio-" + unique + L".db");
}

void RemoveDatabase(const std::wstring& path) {
  DeleteFileW(path.c_str());
  DeleteFileW((path + L"-wal").c_str());
  DeleteFileW((path + L"-shm").c_str());
}

}  // namespace

int main() {
  const std::wstring path = TestDatabasePath();
  try {
    const milo::DatabaseOverview empty = milo::CreateDatabase(path);
    Expect(empty.objects.empty(), "A new database should have no user objects.");

    bool writeRejected = false;
    try {
      milo::ExecuteDatabaseSql(path, "CREATE TABLE blocked(id INTEGER);", false);
    } catch (const std::exception&) {
      writeRejected = true;
    }
    Expect(writeRejected, "Read-only mode must reject schema changes.");

    const milo::DatabaseQueryResult created = milo::ExecuteDatabaseSql(
        path,
        "CREATE TABLE notes(id INTEGER PRIMARY KEY, title TEXT NOT NULL);"
        "INSERT INTO notes(title) VALUES ('C++11'), ('SQLite');",
        true);
    Expect(created.wroteData && created.statementCount == 2,
           "Write mode should execute both statements.");
    Expect(created.affectedRows == 2, "Two inserted rows should be reported.");

    const milo::DatabaseOverview overview = milo::InspectDatabase(path);
    Expect(overview.objects.size() == 1,
           "The created table should appear in the schema overview.");
    Expect(overview.objects[0].name == "notes" &&
               overview.objects[0].columns.size() == 2,
           "Table columns should be inspected.");

    const milo::DatabaseQueryResult selected = milo::ExecuteDatabaseSql(
        path, "SELECT id, title FROM notes ORDER BY id;", false);
    Expect(selected.columns.size() == 2 && selected.rows.size() == 2,
           "The select result should include two columns and rows.");
    Expect(selected.rows[0][1] == "C++11" && selected.rows[1][1] == "SQLite",
           "Text values should round-trip through the query result.");

    const milo::DatabaseQueryResult finalWrite = milo::ExecuteDatabaseSql(
        path,
        "SELECT title FROM notes;"
        "UPDATE notes SET title = 'C' WHERE id = 1;",
        true);
    Expect(finalWrite.columns.empty() && finalWrite.affectedRows == 1,
           "The final write must replace an earlier query result.");

    RemoveDatabase(path);
    std::cout << "Milo database service tests passed.\n";
    return 0;
  } catch (const std::exception& error) {
    RemoveDatabase(path);
    std::cerr << error.what() << '\n';
    return 1;
  }
}
