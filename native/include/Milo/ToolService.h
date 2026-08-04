#pragma once

/// @file
/// @brief C++11 adapter between WebView tool commands and the portable C core.

#include <string>

namespace milo {

/// Value returned by a synchronous local developer-tool operation.
struct ToolExecutionResult {
  bool succeeded{};
  std::string output;
  std::string error;
};

/**
 * Executes one of the allow-listed CloudYi tool operations.
 *
 * The adapter owns buffers, secure random bytes and UTF-8 validation while
 * codecs, hashes and generators remain dependency-free C functions. Inputs
 * are capped to protect the UI thread from unexpectedly large synchronous
 * jobs.
 */
ToolExecutionResult ExecuteTool(const std::string& toolId,
                                const std::string& operation,
                                const std::string& input,
                                bool urlSafe = false,
                                bool padded = true);

}  // namespace milo
