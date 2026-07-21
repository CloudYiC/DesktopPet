set(MILO_DEPS_ROOT "${CMAKE_SOURCE_DIR}/third_party")
set(MILO_SQLITE_ROOT "${MILO_DEPS_ROOT}/sqlite/sqlite-amalgamation-3530300")
set(MILO_WEBVIEW2_ROOT "${MILO_DEPS_ROOT}/webview2/build/native")
set(MILO_JSON_INCLUDE "${MILO_DEPS_ROOT}/nlohmann/include")

foreach(required_file
    "${MILO_SQLITE_ROOT}/sqlite3.c"
    "${MILO_WEBVIEW2_ROOT}/include/WebView2.h"
    "${MILO_WEBVIEW2_ROOT}/x64/WebView2LoaderStatic.lib"
    "${MILO_JSON_INCLUDE}/nlohmann/json.hpp")
  if(NOT EXISTS "${required_file}")
    message(FATAL_ERROR
      "Missing dependency: ${required_file}. Run scripts/bootstrap-native-deps.ps1 first.")
  endif()
endforeach()

add_library(milo_sqlite STATIC "${MILO_SQLITE_ROOT}/sqlite3.c")
target_include_directories(milo_sqlite PUBLIC "${MILO_SQLITE_ROOT}")
target_compile_definitions(milo_sqlite PRIVATE SQLITE_THREADSAFE=1 SQLITE_ENABLE_FTS5)

add_library(milo_webview2 STATIC IMPORTED GLOBAL)
set_target_properties(milo_webview2 PROPERTIES
  IMPORTED_LOCATION "${MILO_WEBVIEW2_ROOT}/x64/WebView2LoaderStatic.lib"
  INTERFACE_INCLUDE_DIRECTORIES "${MILO_WEBVIEW2_ROOT}/include"
)

add_library(milo_json INTERFACE)
target_include_directories(milo_json INTERFACE "${MILO_JSON_INCLUDE}")

add_executable(MiloDesktopPet WIN32
  src/main.cpp
  src/Application.cpp
  src/ReminderStore.cpp
  src/Utils.cpp
  src/WebViewWindow.cpp
)

set_target_properties(MiloDesktopPet PROPERTIES
  OUTPUT_NAME "CuteYiyiDesktopPet"
)

target_include_directories(MiloDesktopPet PRIVATE include)

target_compile_definitions(MiloDesktopPet PRIVATE
  UNICODE
  _UNICODE
  NOMINMAX
  WIN32_LEAN_AND_MEAN
)

if(MSVC)
  target_compile_options(MiloDesktopPet PRIVATE /W4 /permissive- /utf-8)
endif()

target_link_libraries(MiloDesktopPet PRIVATE
  milo_json
  milo_sqlite
  milo_webview2
  comctl32
  dwmapi
  ole32
  sapi
  shell32
  shlwapi
)

add_custom_target(MiloFrontendAssets ALL
  COMMAND ${CMAKE_COMMAND} -E rm -f "$<TARGET_FILE_DIR:MiloDesktopPet>/MiloDesktopPet.exe"
  COMMAND ${CMAKE_COMMAND} -E rm -rf "$<TARGET_FILE_DIR:MiloDesktopPet>/ui"
  COMMAND ${CMAKE_COMMAND} -E copy_directory
    "${CMAKE_SOURCE_DIR}/frontend/dist"
    "$<TARGET_FILE_DIR:MiloDesktopPet>/ui"
  COMMENT "Copying React UI next to CuteYiyiDesktopPet.exe"
)

add_dependencies(MiloDesktopPet MiloFrontendAssets)

set_property(TARGET MiloDesktopPet PROPERTY
  VS_DEBUGGER_WORKING_DIRECTORY "$<TARGET_FILE_DIR:MiloDesktopPet>"
)

if(BUILD_TESTING)
  add_executable(MiloReminderStoreTests
    tests/ReminderStoreTests.cpp
    src/ReminderStore.cpp
    src/Utils.cpp
  )
  target_include_directories(MiloReminderStoreTests PRIVATE include)
  target_compile_definitions(MiloReminderStoreTests PRIVATE
    UNICODE
    _UNICODE
    NOMINMAX
    WIN32_LEAN_AND_MEAN
  )
  target_link_libraries(MiloReminderStoreTests PRIVATE
    milo_sqlite
    ole32
    shell32
  )
  if(MSVC)
    target_compile_options(MiloReminderStoreTests PRIVATE /W4 /permissive- /utf-8)
  endif()
  add_test(NAME MiloReminderStoreTests COMMAND MiloReminderStoreTests)
endif()
