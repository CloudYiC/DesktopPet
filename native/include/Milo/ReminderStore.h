#pragma once

#include <cstdint>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

struct sqlite3;

namespace milo {

struct Reminder {
  std::int64_t id{};
  std::string title;
  std::int64_t dueAt{};
  bool completed{};
  bool notified{};
  std::string repeatRule{"none"};
  std::string priority{"normal"};
};

class ReminderStore final {
 public:
  ReminderStore() = default;
  ~ReminderStore();

  ReminderStore(const ReminderStore&) = delete;
  ReminderStore& operator=(const ReminderStore&) = delete;

  void Open(const std::wstring& databasePath);
  std::vector<Reminder> List();
  Reminder Create(const std::string& title, std::int64_t dueAt,
                  const std::string& repeatRule,
                  const std::string& priority = "normal");
  void Complete(std::int64_t id, std::int64_t now);
  void Remove(std::int64_t id);
  void Snooze(std::int64_t id, std::int64_t dueAt);
  std::vector<Reminder> TakeDue(std::int64_t now);
  std::optional<std::string> GetSetting(const std::string& key);
  void SetSetting(const std::string& key, const std::string& value);

 private:
  void Execute(const char* sql);
  bool ColumnExists(const char* table, const char* column);

  sqlite3* database_{};
  std::mutex mutex_;
};

}  // namespace milo
