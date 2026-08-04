#include <windows.h>
#include <commdlg.h>
#include <wchar.h>

#include "cloudyi/file_dialog.h"

int cy_pick_sqlite_database(void *owner_window, int create_new,
                            wchar_t *destination, size_t capacity) {
  OPENFILENAMEW dialog;
  BOOL selected;
  if (!destination || capacity < 4 || capacity > (size_t)0xffffffffU) {
    return -1;
  }
  destination[0] = L'\0';
  ZeroMemory(&dialog, sizeof(dialog));
  dialog.lStructSize = sizeof(dialog);
  dialog.hwndOwner = (HWND)owner_window;
  dialog.lpstrFilter =
      L"SQLite 数据库 (*.db;*.sqlite;*.sqlite3)\0*.db;*.sqlite;*.sqlite3\0"
      L"所有文件 (*.*)\0*.*\0\0";
  dialog.lpstrFile = destination;
  dialog.nMaxFile = (DWORD)capacity;
  dialog.lpstrDefExt = L"db";
  dialog.Flags = OFN_EXPLORER | OFN_NOCHANGEDIR | OFN_PATHMUSTEXIST |
                 OFN_HIDEREADONLY;
  if (create_new) {
    dialog.Flags |= OFN_NOREADONLYRETURN;
    dialog.lpstrTitle = L"新建 SQLite 数据库";
    selected = GetSaveFileNameW(&dialog);
  } else {
    dialog.Flags |= OFN_FILEMUSTEXIST;
    dialog.lpstrTitle = L"打开 SQLite 数据库";
    selected = GetOpenFileNameW(&dialog);
  }
  if (selected) return 1;
  return CommDlgExtendedError() == 0 ? 0 : -1;
}

int cy_pick_image_destination(void *owner_window, const wchar_t *format,
                              const wchar_t *suggested_name,
                              wchar_t *destination, size_t capacity) {
  OPENFILENAMEW dialog;
  const wchar_t *filter;
  const wchar_t *extension;
  if (!destination || !format || capacity < 4 ||
      capacity > (size_t)0xffffffffU) {
    return -1;
  }
  if (wcscmp(format, L"png") == 0) {
    filter = L"PNG 图片 (*.png)\0*.png\0\0";
    extension = L"png";
  } else if (wcscmp(format, L"jpeg") == 0) {
    filter = L"JPEG 图片 (*.jpg;*.jpeg)\0*.jpg;*.jpeg\0\0";
    extension = L"jpg";
  } else if (wcscmp(format, L"webp") == 0) {
    filter = L"WebP 图片 (*.webp)\0*.webp\0\0";
    extension = L"webp";
  } else if (wcscmp(format, L"ico") == 0) {
    filter = L"Windows 图标 (*.ico)\0*.ico\0\0";
    extension = L"ico";
  } else {
    return -1;
  }

  destination[0] = L'\0';
  if (suggested_name && suggested_name[0] != L'\0') {
    wcsncpy_s(destination, capacity, suggested_name, _TRUNCATE);
  }
  ZeroMemory(&dialog, sizeof(dialog));
  dialog.lStructSize = sizeof(dialog);
  dialog.hwndOwner = (HWND)owner_window;
  dialog.lpstrFilter = filter;
  dialog.lpstrFile = destination;
  dialog.nMaxFile = (DWORD)capacity;
  dialog.lpstrDefExt = extension;
  dialog.lpstrTitle = L"保存转换后的图片";
  dialog.Flags = OFN_EXPLORER | OFN_NOCHANGEDIR | OFN_PATHMUSTEXIST |
                 OFN_OVERWRITEPROMPT | OFN_NOREADONLYRETURN;
  if (GetSaveFileNameW(&dialog)) return 1;
  return CommDlgExtendedError() == 0 ? 0 : -1;
}
