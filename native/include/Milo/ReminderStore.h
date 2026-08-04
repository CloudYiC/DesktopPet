#pragma once

/// @file
/// @brief Thread-safe SQLite persistence for reminders and application settings.

#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

struct sqlite3;

namespace milo {

/// Reminder record exchanged between SQLite, native code and React.
struct Reminder {
  /// SQLite row identifier.
  std::int64_t id{};
  std::string title;
  /// Due time expressed as Unix epoch milliseconds.
  std::int64_t dueAt{};
  bool completed{};
  /// Prevents a due occurrence from being announced more than once.
  bool notified{};
  /// `none`, `daily`, `weekdays` or `weekly`.
  std::string repeatRule{"none"};
  /// `normal`, `important` or `urgent`.
  std::string priority{"normal"};
};

/// Serializes access to one SQLite connection with an internal mutex.
class ReminderStore final {
 public:
  ReminderStore() = default;
  ~ReminderStore();

  ReminderStore(const ReminderStore&) = delete;
  ReminderStore& operator=(const ReminderStore&) = delete;

  /// Opens or creates the database and applies idempotent schema migrations.
  void Open(const std::wstring& databasePath);
  /// Returns all incomplete reminders ordered by due time.
  std::vector<Reminder> List();
  /// Inserts a reminder and returns its persisted representation.
  Reminder Create(const std::string& title, std::int64_t dueAt,
                  const std::string& repeatRule,
                  const std::string& priority = "normal");
  /// Completes a one-off reminder or advances a recurring reminder.
  void Complete(std::int64_t id, std::int64_t now);
  /// Permanently deletes one reminder row.
  void Remove(std::int64_t id);
  /// Moves a reminder to a new time and clears its notification marker.
  void Snooze(std::int64_t id, std::int64_t dueAt);
  /// Atomically claims due reminders so each occurrence is emitted once.
  std::vector<Reminder> TakeDue(std::int64_t now);
  /// Reads a setting into value and returns false when the key is absent.
  bool GetSetting(const std::string& key, std::string& value);
  /// Inserts or replaces a key/value application setting.
  void SetSetting(const std::string& key, const std::string& value);

 private:
  void Execute(const char* sql);
  bool ColumnExists(const char* table, const char* column);

  sqlite3* database_{};
  std::mutex mutex_;
};

}  // namespace milo
