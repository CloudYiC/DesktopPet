#include <windows.h>

#include <filesystem>
#include <iostream>
#include <stdexcept>
#include <string>

#include "Milo/ReminderStore.h"
#include "Milo/Utils.h"

namespace {

void Expect(bool condition, const char* message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

std::filesystem::path TestDatabasePath() {
  const auto unique = std::to_wstring(GetCurrentProcessId()) + L"-" +
                      std::to_wstring(milo::UnixTimeMilliseconds());
  return std::filesystem::temp_directory_path() /
         (L"milo-reminder-store-" + unique + L".db");
}

}  // namespace

int main() {
  const std::filesystem::path databasePath = TestDatabasePath();
  try {
    {
      milo::ReminderStore store;
      store.Open(databasePath.wstring());

      const auto now = milo::UnixTimeMilliseconds();
      const milo::Reminder first =
          store.Create("Test reminder", now - 1000, "none", "important");
      Expect(first.id > 0, "Create should assign an id.");
      Expect(store.List().size() == 1, "List should return the new reminder.");
      Expect(store.List()[0].priority == "important",
             "Priority should round-trip through SQLite.");

      const auto due = store.TakeDue(now);
      Expect(due.size() == 1, "A due reminder should be returned once.");
      Expect(store.TakeDue(now).empty(),
             "A notified reminder should not be returned twice.");

      store.Snooze(first.id, now - 1);
      Expect(store.TakeDue(now).size() == 1,
             "Snoozing should make the reminder eligible again.");

      store.Complete(first.id, now);
      Expect(store.List().empty(), "Completed reminders should leave the list.");

      const milo::Reminder repeating =
          store.Create("Daily habit", now - 1000, "daily");
      store.Complete(repeating.id, now);
      const auto repeatedItems = store.List();
      Expect(repeatedItems.size() == 1,
             "Repeating reminders should remain active after completion.");
      Expect(repeatedItems[0].dueAt > now,
             "Repeating reminders should advance to a future time.");
      Expect(repeatedItems[0].repeatRule == "daily",
             "The repeat rule should be preserved.");
      store.Remove(repeating.id);

      store.SetSetting("pet.x", "128");
      Expect(store.GetSetting("pet.x") == "128",
             "Settings should round-trip through SQLite.");

      const milo::Reminder second =
          store.Create("Delete me", now + 60'000, "none");
      store.Remove(second.id);
      Expect(store.List().empty(), "Deleted reminders should leave the list.");
    }

    std::filesystem::remove(databasePath);
    std::filesystem::remove(databasePath.wstring() + L"-wal");
    std::filesystem::remove(databasePath.wstring() + L"-shm");
    std::cout << "Milo reminder store tests passed.\n";
    return 0;
  } catch (const std::exception& error) {
    std::filesystem::remove(databasePath);
    std::filesystem::remove(databasePath.wstring() + L"-wal");
    std::filesystem::remove(databasePath.wstring() + L"-shm");
    std::cerr << error.what() << '\n';
    return 1;
  }
}
