cmake_minimum_required(VERSION 3.24)

project(CloudYiAssistant VERSION 0.12.1 LANGUAGES C CXX)

include(CTest)

set(CMAKE_CXX_STANDARD 11)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_subdirectory(native)
