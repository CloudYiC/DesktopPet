set(MILO_DEPS_ROOT "${CMAKE_SOURCE_DIR}/third_party")
set(MILO_SQLITE_ROOT "${MILO_DEPS_ROOT}/sqlite/sqlite-amalgamation-3530300")
set(MILO_WEBVIEW2_ROOT "${MILO_DEPS_ROOT}/webview2/build/native")
set(MILO_JSON_INCLUDE "${MILO_DEPS_ROOT}/nlohmann/include")

# The official build script selects a generated private character icon when the
# local artwork exists. Direct/public CMake builds retain the tracked mouse icon.
set(CLOUDYI_APP_ICON
  "${CMAKE_CURRENT_SOURCE_DIR}/resources/CuteYiyiDesktopPet.ico"
  CACHE FILEPATH "ICO file embedded in the CloudYi Assistant executable")
get_filename_component(CLOUDYI_APP_ICON "${CLOUDYI_APP_ICON}" ABSOLUTE)
if(NOT EXISTS "${CLOUDYI_APP_ICON}")
  message(FATAL_ERROR "Application icon does not exist: ${CLOUDYI_APP_ICON}")
endif()
set(CLOUDYI_GENERATED_RESOURCE_DIR "${CMAKE_CURRENT_BINARY_DIR}/generated")
file(MAKE_DIRECTORY "${CLOUDYI_GENERATED_RESOURCE_DIR}")
configure_file(
  "${CLOUDYI_APP_ICON}"
  "${CLOUDYI_GENERATED_RESOURCE_DIR}/CuteYiyiDesktopPet.ico"
  COPYONLY
)
configure_file(
  resources/CuteYiyiDesktopPet.rc.in
  "${CLOUDYI_GENERATED_RESOURCE_DIR}/CuteYiyiDesktopPet.rc"
  COPYONLY
)
configure_file(
  resources/CloudYiAssistant.manifest
  "${CLOUDYI_GENERATED_RESOURCE_DIR}/CloudYiAssistant.manifest"
  COPYONLY
)

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

# Portable CloudYi algorithms remain C so existing implementations can move
# here without a language rewrite. C++11 code reaches them through ToolService.
add_library(cloudyi_core_c STATIC
  c_core/src/base64.c
  c_core/src/hex.c
  c_core/src/md5.c
  c_core/src/modbus_protocol.c
  c_core/src/mqtt_codec.c
  c_core/src/packet_inspector.c
  c_core/src/pet_behavior.c
  c_core/src/sha256.c
  c_core/src/store_tools.c
  c_core/src/url_encode.c
)
target_include_directories(cloudyi_core_c PUBLIC c_core/include)
if(MSVC)
  target_compile_options(cloudyi_core_c PRIVATE /W4 /utf-8)
endif()

# Real desktop-only communication services. Pure protocol framing stays in C;
# cancellable worker ownership and JSON validation remain at the C++11 boundary.
add_library(cloudyi_debuggers STATIC
  src/SerialPortWin32.c
  src/SerialDebugService.cpp
  src/MqttDebugService.cpp
  src/ModbusDebugService.cpp
)
target_include_directories(cloudyi_debuggers PUBLIC include)
target_compile_definitions(cloudyi_debuggers PRIVATE
  UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN SECURITY_WIN32
)
target_link_libraries(cloudyi_debuggers PUBLIC milo_json cloudyi_core_c
  PRIVATE ws2_32 advapi32 secur32 crypt32
)
if(MSVC)
  target_compile_options(cloudyi_debuggers PRIVATE /W4 /utf-8)
endif()

# Windows metrics remain procedural C while the C++11 service owns strings,
# dynamic buffers and permission checks for higher-risk operations.
add_library(cloudyi_win32_c STATIC
  win32_c/src/file_dialog.c
  win32_c/src/icon_file.c
  win32_c/src/network_debug.c
  win32_c/src/software_inventory.c
  win32_c/src/system_metrics.c
)
target_include_directories(cloudyi_win32_c PUBLIC win32_c/include)
target_compile_definitions(cloudyi_win32_c PRIVATE
  UNICODE
  _UNICODE
  WIN32_LEAN_AND_MEAN
)
target_link_libraries(cloudyi_win32_c PRIVATE
  advapi32
  comdlg32
  iphlpapi
  user32
  ws2_32
)
if(MSVC)
  # File-dialog labels are UTF-8 source literals consumed by wide Win32 APIs.
  target_compile_options(cloudyi_win32_c PRIVATE /W4 /utf-8)
endif()

add_executable(MiloDesktopPet WIN32
  "${CLOUDYI_GENERATED_RESOURCE_DIR}/CuteYiyiDesktopPet.rc"
  src/main.cpp
  src/Application.cpp
  src/CharacterImage.cpp
  src/DatabaseService.cpp
  src/ImageService.cpp
  src/NetworkDebugService.cpp
  src/ReminderStore.cpp
  src/SoftwareService.cpp
  src/SystemService.cpp
  src/ToolService.cpp
  src/Utils.cpp
  src/WebViewWindow.cpp
)

set_target_properties(MiloDesktopPet PROPERTIES
  OUTPUT_NAME "CuteYiyiDesktopPet"
)

if(MSVC)
  # The resource script embeds a PerMonitorV2 manifest. Disable the linker's
  # generated manifest so it cannot replace resource ID 1 with a DPI-unaware
  # default manifest.
  target_link_options(MiloDesktopPet PRIVATE /MANIFEST:NO)
endif()

target_include_directories(MiloDesktopPet PRIVATE include resources)

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
  cloudyi_core_c
  cloudyi_win32_c
  cloudyi_debuggers
  bcrypt
  comdlg32
  comctl32
  crypt32
  dwmapi
  ole32
  sapi
  shell32
  uuid
  shlwapi
  iphlpapi
  version
  ws2_32
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
  # Pure policy checks need no windows, real reminders or installed app state.
  add_executable(MiloPetBehaviorTests tests/PetBehaviorTests.c)
  target_link_libraries(MiloPetBehaviorTests PRIVATE cloudyi_core_c)
  if(MSVC)
    target_compile_options(MiloPetBehaviorTests PRIVATE /W4 /utf-8)
  endif()
  add_test(NAME MiloPetBehaviorTests COMMAND MiloPetBehaviorTests)

  add_executable(MiloCharacterImageTests
    tests/CharacterImageTests.cpp
    src/CharacterImage.cpp
  )
  target_include_directories(MiloCharacterImageTests PRIVATE include)
  target_compile_definitions(MiloCharacterImageTests PRIVATE
    UNICODE
    _UNICODE
    NOMINMAX
    WIN32_LEAN_AND_MEAN
  )
  target_link_libraries(MiloCharacterImageTests PRIVATE crypt32)
  if(MSVC)
    target_compile_options(MiloCharacterImageTests PRIVATE
      /W4 /permissive- /utf-8)
  endif()
  add_test(NAME MiloCharacterImageTests COMMAND MiloCharacterImageTests)

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

  add_executable(MiloToolServiceTests
    tests/ToolServiceTests.cpp
    src/ToolService.cpp
    src/Utils.cpp
  )
  target_include_directories(MiloToolServiceTests PRIVATE include)
  target_compile_definitions(MiloToolServiceTests PRIVATE
    UNICODE
    _UNICODE
    NOMINMAX
    WIN32_LEAN_AND_MEAN
  )
  target_link_libraries(MiloToolServiceTests PRIVATE
    milo_json
    cloudyi_core_c
    bcrypt
    ole32
    shell32
  )
  if(MSVC)
    target_compile_options(MiloToolServiceTests PRIVATE
      /W4 /permissive- /utf-8
    )
  endif()
  add_test(NAME MiloToolServiceTests COMMAND MiloToolServiceTests)

  add_executable(MiloSystemServiceTests
    tests/SystemServiceTests.cpp
    src/SystemService.cpp
    src/Utils.cpp
  )
  target_include_directories(MiloSystemServiceTests PRIVATE include)
  target_compile_definitions(MiloSystemServiceTests PRIVATE
    UNICODE
    _UNICODE
    NOMINMAX
    WIN32_LEAN_AND_MEAN
  )
  target_link_libraries(MiloSystemServiceTests PRIVATE
    cloudyi_win32_c
    iphlpapi
    ws2_32
    ole32
    shell32
  )
  if(MSVC)
    target_compile_options(MiloSystemServiceTests PRIVATE
      /W4 /permissive- /utf-8
    )
  endif()
  add_test(NAME MiloSystemServiceTests COMMAND MiloSystemServiceTests)

  add_executable(MiloNetworkDebugServiceTests
    tests/NetworkDebugServiceTests.cpp
    src/NetworkDebugService.cpp
  )
  target_include_directories(MiloNetworkDebugServiceTests PRIVATE include)
  target_compile_definitions(MiloNetworkDebugServiceTests PRIVATE
    UNICODE
    _UNICODE
    NOMINMAX
    WIN32_LEAN_AND_MEAN
  )
  target_link_libraries(MiloNetworkDebugServiceTests PRIVATE
    cloudyi_win32_c
    iphlpapi
    ws2_32
  )
  if(MSVC)
    target_compile_options(MiloNetworkDebugServiceTests PRIVATE
      /W4 /permissive- /utf-8
    )
  endif()
  add_test(NAME MiloNetworkDebugServiceTests
    COMMAND MiloNetworkDebugServiceTests)
  set_tests_properties(MiloNetworkDebugServiceTests PROPERTIES TIMEOUT 30)

  add_executable(MiloSoftwareServiceTests
    tests/SoftwareServiceTests.cpp
    src/SoftwareService.cpp
    src/Utils.cpp
  )
  target_include_directories(MiloSoftwareServiceTests PRIVATE include)
  target_compile_definitions(MiloSoftwareServiceTests PRIVATE
    UNICODE
    _UNICODE
    NOMINMAX
    WIN32_LEAN_AND_MEAN
  )
  target_link_libraries(MiloSoftwareServiceTests PRIVATE
    cloudyi_win32_c
    bcrypt
    ole32
    shell32
    uuid
    version
  )
  if(MSVC)
    target_compile_options(MiloSoftwareServiceTests PRIVATE
      /W4 /permissive- /utf-8
    )
  endif()
  add_test(NAME MiloSoftwareServiceTests COMMAND MiloSoftwareServiceTests)

  add_executable(MiloDatabaseServiceTests
    tests/DatabaseServiceTests.cpp
    src/DatabaseService.cpp
    src/Utils.cpp
  )
  target_include_directories(MiloDatabaseServiceTests PRIVATE include)
  target_compile_definitions(MiloDatabaseServiceTests PRIVATE
    UNICODE
    _UNICODE
    NOMINMAX
    WIN32_LEAN_AND_MEAN
  )
  target_link_libraries(MiloDatabaseServiceTests PRIVATE
    milo_sqlite
    ole32
    shell32
  )
  if(MSVC)
    target_compile_options(MiloDatabaseServiceTests PRIVATE
      /W4 /permissive- /utf-8
    )
  endif()
  add_test(NAME MiloDatabaseServiceTests COMMAND MiloDatabaseServiceTests)

  # These tests use protocol vectors and loopback-only synthetic peers. They do
  # not require attached serial hardware and never contact a real device.
  add_executable(MiloModbusProtocolTests tests/ModbusProtocolTests.c)
  target_link_libraries(MiloModbusProtocolTests PRIVATE cloudyi_core_c)
  if(MSVC)
    target_compile_options(MiloModbusProtocolTests PRIVATE /W4 /utf-8)
  endif()
  add_test(NAME MiloModbusProtocolTests COMMAND MiloModbusProtocolTests)
  foreach(debugger_test SerialDebugService MqttCodec MqttDebugService ModbusDebugService)
    add_executable(Milo${debugger_test}Tests tests/${debugger_test}Tests.cpp)
    target_link_libraries(Milo${debugger_test}Tests PRIVATE cloudyi_debuggers
      ws2_32 advapi32 secur32 crypt32)
    target_compile_definitions(Milo${debugger_test}Tests PRIVATE
      UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN)
    if(MSVC)
      target_compile_options(Milo${debugger_test}Tests PRIVATE /W4 /permissive- /utf-8)
    endif()
    add_test(NAME Milo${debugger_test}Tests COMMAND Milo${debugger_test}Tests)
    set_tests_properties(Milo${debugger_test}Tests PROPERTIES TIMEOUT 60)
  endforeach()
endif()
