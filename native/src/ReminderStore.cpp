#include "Milo/ReminderStore.h"

#include <sqlite3.h>

#include <ctime>
#include <stdexcept>
#include <utility>

#include "Milo/Utils.h"

namespace milo {
namespace {

class Statement final {
 public:
  Statement(sqlite3* database, const char* sql) : database_(database) {
    if (sqlite3_prepare_v2(database, sql, -1, &statement_, nullptr) !=
        SQLITE_OK) {
      throw std::runtime_error(sqlite3_errmsg(database));
    }
  }

  ~Statement() { sqlite3_finalize(statement_); }

  Statement(const Statement&) = delete;
  Statement& operator=(const Statement&) = delete;

  sqlite3_stmt* Get() const { return statement_; }

  void ExpectDone() {
    if (sqlite3_step(statement_) != SQLITE_DONE) {
      throw std::runtime_error(sqlite3_errmsg(database_));
    }
  }

 private:
  sqlite3* database_{};
  sqlite3_stmt* statement_{};
};

Reminder ReadReminder(sqlite3_stmt* statement) {
  Reminder reminder;
  reminder.id = sqlite3_column_int64(statement, 0);
  const auto* title = sqlite3_column_text(statement, 1);
  reminder.title = title == nullptr ? "" : reinterpret_cast<const char*>(title);
  reminder.dueAt = sqlite3_column_int64(statement, 2);
  reminder.completed = sqlite3_column_int(statement, 3) != 0;
  reminder.notified = sqlite3_column_int(statement, 4) != 0;
  const auto* repeatRule = sqlite3_column_text(statement, 5);
  reminder.repeatRule =
      repeatRule == nullptr ? "none" : reinterpret_cast<const char*>(repeatRule);
  const auto* priority = sqlite3_column_text(statement, 6);
  reminder.priority =
      priority == nullptr ? "normal" : reinterpret_cast<const char*>(priority);
  return reminder;
}

std::int64_t AddCalendarDays(std::int64_t timestamp, int days) {
  const std::time_t seconds = static_cast<std::time_t>(timestamp / 1000);
  std::tm local{};
  localtime_s(&local, &seconds);
  local.tm_mday += days;
  local.tm_isdst = -1;
  const std::time_t adjusted = std::mktime(&local);
  if (adjusted == static_cast<std::time_t>(-1)) {
    throw std::runtime_error("Unable to calculate the next reminder time.");
  }
  return static_cast<std::int64_t>(adjusted) * 1000 + timestamp % 1000;
}

std::int64_t NextOccurrence(std::int64_t dueAt, const std::string& rule,
                            std::int64_t now) {
  std::int64_t candidate = dueAt;
  do {
    candidate = AddCalendarDays(candidate, rule == "weekly" ? 7 : 1);
    if (rule == "weekdays") {
      for (;;) {
        const std::time_t seconds = static_cast<std::time_t>(candidate / 1000);
        std::tm local{};
        localtime_s(&local, &seconds);
        if (local.tm_wday != 0 && local.tm_wday != 6) {
          break;
        }
        candidate = AddCalendarDays(candidate, 1);
      }
    }
  } while (candidate <= now);
  return candidate;
}

}  // namespace

ReminderStore::~ReminderStore() {
  if (database_ != nullptr) {
    sqlite3_close(database_);
  }
}

void ReminderStore::Open(const std::wstring& databasePath) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (database_ != nullptr) {
    return;
  }

  const std::string utf8Path = WideToUtf8(databasePath);
  if (sqlite3_open_v2(utf8Path.c_str(), &database_,
                      SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE |
                          SQLITE_OPEN_FULLMUTEX,
                      nullptr) != SQLITE_OK) {
    const std::string message =
        database_ == nullptr ? "Unable to open reminder database."
                             : sqlite3_errmsg(database_);
    if (database_ != nullptr) {
      sqlite3_close(database_);
      database_ = nullptr;
    }
    throw std::runtime_error(message);
  }

  Execute("PRAGMA journal_mode=WAL;");
  Execute("PRAGMA foreign_keys=ON;");
  Execute(
      "CREATE TABLE IF NOT EXISTS reminders ("
      "id INTEGER PRIMARY KEY AUTOINCREMENT,"
      "title TEXT NOT NULL,"
      "due_at INTEGER NOT NULL,"
      "completed INTEGER NOT NULL DEFAULT 0,"
      "notified INTEGER NOT NULL DEFAULT 0,"
      "repeat_rule TEXT NOT NULL DEFAULT 'none',"
      "priority TEXT NOT NULL DEFAULT 'normal',"
      "created_at INTEGER NOT NULL"
      ");");
  if (!ColumnExists("reminders", "repeat_rule")) {
    Execute("ALTER TABLE reminders ADD COLUMN repeat_rule TEXT NOT NULL "
            "DEFAULT 'none';");
  }
  if (!ColumnExists("reminders", "priority")) {
    Execute("ALTER TABLE reminders ADD COLUMN priority TEXT NOT NULL "
            "DEFAULT 'normal';");
  }
  Execute(
      "CREATE TABLE IF NOT EXISTS app_settings ("
      "key TEXT PRIMARY KEY,"
      "value TEXT NOT NULL"
      ");");
  Execute("CREATE INDEX IF NOT EXISTS idx_reminders_due "
          "ON reminders(completed, notified, due_at);");
}

bool ReminderStore::ColumnExists(const char* table, const char* column) {
  const std::string sql = std::string("PRAGMA table_info(") + table + ");";
  Statement statement(database_, sql.c_str());
  int result = SQLITE_ROW;
  while ((result = sqlite3_step(statement.Get())) == SQLITE_ROW) {
    const auto* name = sqlite3_column_text(statement.Get(), 1);
    if (name != nullptr &&
        std::string(reinterpret_cast<const char*>(name)) == column) {
      return true;
    }
  }
  if (result != SQLITE_DONE) {
    throw std::runtime_error(sqlite3_errmsg(database_));
  }
  return false;
}

void ReminderStore::Execute(const char* sql) {
  char* error = nullptr;
  if (sqlite3_exec(database_, sql, nullptr, nullptr, &error) != SQLITE_OK) {
    const std::string message = error == nullptr ? "SQLite error" : error;
    sqlite3_free(error);
    throw std::runtime_error(message);
  }
}

std::vector<Reminder> ReminderStore::List() {
  std::lock_guard<std::mutex> lock(mutex_);
  Statement statement(
      database_,
      "SELECT id, title, due_at, completed, notified, repeat_rule, priority "
      "FROM reminders "
      "WHERE completed = 0 ORDER BY due_at ASC;");

  std::vector<Reminder> reminders;
  int result = SQLITE_ROW;
  while ((result = sqlite3_step(statement.Get())) == SQLITE_ROW) {
    reminders.push_back(ReadReminder(statement.Get()));
  }
  if (result != SQLITE_DONE) {
    throw std::runtime_error(sqlite3_errmsg(database_));
  }
  return reminders;
}

Reminder ReminderStore::Create(const std::string& title, std::int64_t dueAt,
                               const std::string& repeatRule,
                               const std::string& priority) {
  std::lock_guard<std::mutex> lock(mutex_);
  Statement statement(
      database_,
      "INSERT INTO reminders(title, due_at, completed, notified, repeat_rule, "
      "priority, created_at) VALUES (?, ?, 0, 0, ?, ?, ?);");
  sqlite3_bind_text(statement.Get(), 1, title.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_int64(statement.Get(), 2, dueAt);
  sqlite3_bind_text(statement.Get(), 3, repeatRule.c_str(), -1,
                    SQLITE_TRANSIENT);
  sqlite3_bind_text(statement.Get(), 4, priority.c_str(), -1,
                    SQLITE_TRANSIENT);
  sqlite3_bind_int64(statement.Get(), 5, UnixTimeMilliseconds());
  statement.ExpectDone();

  return Reminder{sqlite3_last_insert_rowid(database_), title, dueAt, false,
                  false, repeatRule, priority};
}

void ReminderStore::Complete(std::int64_t id, std::int64_t now) {
  std::lock_guard<std::mutex> lock(mutex_);
  Statement select(database_,
                   "SELECT due_at, repeat_rule FROM reminders "
                   "WHERE id = ? AND completed = 0;");
  sqlite3_bind_int64(select.Get(), 1, id);
  const int selectResult = sqlite3_step(select.Get());
  if (selectResult == SQLITE_DONE) {
    return;
  }
  if (selectResult != SQLITE_ROW) {
    throw std::runtime_error(sqlite3_errmsg(database_));
  }

  const auto dueAt = sqlite3_column_int64(select.Get(), 0);
  const auto* rawRule = sqlite3_column_text(select.Get(), 1);
  const std::string rule =
      rawRule == nullptr ? "none" : reinterpret_cast<const char*>(rawRule);

  if (rule == "daily" || rule == "weekdays" || rule == "weekly") {
    Statement update(database_,
                     "UPDATE reminders SET due_at = ?, notified = 0 "
                     "WHERE id = ?;");
    sqlite3_bind_int64(update.Get(), 1, NextOccurrence(dueAt, rule, now));
    sqlite3_bind_int64(update.Get(), 2, id);
    update.ExpectDone();
  } else {
    Statement update(database_,
                     "UPDATE reminders SET completed = 1 WHERE id = ?;");
    sqlite3_bind_int64(update.Get(), 1, id);
    update.ExpectDone();
  }
}

void ReminderStore::Remove(std::int64_t id) {
  std::lock_guard<std::mutex> lock(mutex_);
  Statement statement(database_, "DELETE FROM reminders WHERE id = ?;");
  sqlite3_bind_int64(statement.Get(), 1, id);
  statement.ExpectDone();
}

void ReminderStore::Snooze(std::int64_t id, std::int64_t dueAt) {
  std::lock_guard<std::mutex> lock(mutex_);
  Statement statement(
      database_,
      "UPDATE reminders SET due_at = ?, notified = 0 WHERE id = ?;");
  sqlite3_bind_int64(statement.Get(), 1, dueAt);
  sqlite3_bind_int64(statement.Get(), 2, id);
  statement.ExpectDone();
}

std::vector<Reminder> ReminderStore::TakeDue(std::int64_t now) {
  std::lock_guard<std::mutex> lock(mutex_);
  Execute("BEGIN IMMEDIATE TRANSACTION;");
  try {
    Statement select(
        database_,
        "SELECT id, title, due_at, completed, notified, repeat_rule, priority "
        "FROM reminders "
        "WHERE completed = 0 AND notified = 0 AND due_at <= ? "
        "ORDER BY due_at ASC;");
    sqlite3_bind_int64(select.Get(), 1, now);

    std::vector<Reminder> due;
    int result = SQLITE_ROW;
    while ((result = sqlite3_step(select.Get())) == SQLITE_ROW) {
      due.push_back(ReadReminder(select.Get()));
    }
    if (result != SQLITE_DONE) {
      throw std::runtime_error(sqlite3_errmsg(database_));
    }

    Statement update(database_,
                     "UPDATE reminders SET notified = 1 WHERE id = ?;");
    for (const Reminder& reminder : due) {
      sqlite3_reset(update.Get());
      sqlite3_clear_bindings(update.Get());
      sqlite3_bind_int64(update.Get(), 1, reminder.id);
      update.ExpectDone();
    }

    Execute("COMMIT;");
    return due;
  } catch (...) {
    Execute("ROLLBACK;");
    throw;
  }
}

std::optional<std::string> ReminderStore::GetSetting(const std::string& key) {
  std::lock_guard<std::mutex> lock(mutex_);
  Statement statement(database_,
                      "SELECT value FROM app_settings WHERE key = ?;");
  sqlite3_bind_text(statement.Get(), 1, key.c_str(), -1, SQLITE_TRANSIENT);
  const int result = sqlite3_step(statement.Get());
  if (result == SQLITE_DONE) {
    return std::nullopt;
  }
  if (result != SQLITE_ROW) {
    throw std::runtime_error(sqlite3_errmsg(database_));
  }
  const auto* value = sqlite3_column_text(statement.Get(), 0);
  return value == nullptr
             ? std::optional<std::string>{std::string{}}
             : std::optional<std::string>{
                   reinterpret_cast<const char*>(value)};
}

void ReminderStore::SetSetting(const std::string& key,
                               const std::string& value) {
  std::lock_guard<std::mutex> lock(mutex_);
  Statement statement(
      database_,
      "INSERT INTO app_settings(key, value) VALUES(?, ?) "
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value;");
  sqlite3_bind_text(statement.Get(), 1, key.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(statement.Get(), 2, value.c_str(), -1, SQLITE_TRANSIENT);
  statement.ExpectDone();
}

}  // namespace milo
