#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include "cloudyi/network_debug.h"

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>

#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static SOCKET cy_native_socket(cy_net_socket socket_value) {
  return (SOCKET)socket_value;
}

static cy_net_socket cy_public_socket(SOCKET socket_value) {
  return (cy_net_socket)socket_value;
}

static void cy_store_error(int *error_code, int value) {
  if (error_code != NULL) {
    *error_code = value;
  }
}

static int cy_socket_type_value(int socket_type) {
  return socket_type == CY_NET_SOCKET_DATAGRAM ? SOCK_DGRAM : SOCK_STREAM;
}

static int cy_protocol_value(int socket_type) {
  return socket_type == CY_NET_SOCKET_DATAGRAM ? IPPROTO_UDP : IPPROTO_TCP;
}

static int cy_copy_sockaddr(cy_net_address *destination,
                            const struct sockaddr *source, int length,
                            int socket_type, int protocol) {
  if (destination == NULL || source == NULL || length <= 0 ||
      (size_t)length > sizeof(destination->storage.bytes)) {
    return 0;
  }
  memset(destination, 0, sizeof(*destination));
  memcpy(destination->storage.bytes, source, (size_t)length);
  destination->length = length;
  destination->family = source->sa_family;
  destination->socket_type = socket_type;
  destination->protocol = protocol;
  return 1;
}

#define CY_NET_RESOLVE_TIMEOUT_MS 5000UL

typedef struct cy_resolve_context {
  OVERLAPPED overlapped;
  PADDRINFOEXW results;
  HANDLE complete_event;
  volatile LONG references;
  volatile LONG completion_error;
  int owns_winsock_reference;
} cy_resolve_context;

static void cy_release_resolve_context(cy_resolve_context *context) {
  if (context != NULL && InterlockedDecrement(&context->references) == 0) {
    if (context->results != NULL) {
      FreeAddrInfoExW(context->results);
    }
    if (context->complete_event != NULL) {
      CloseHandle(context->complete_event);
    }
    if (context->owns_winsock_reference) {
      WSACleanup();
    }
    free(context);
  }
}

static void CALLBACK cy_resolve_completed(DWORD error, DWORD bytes,
                                          LPOVERLAPPED overlapped) {
  cy_resolve_context *context;
  (void)bytes;
  if (overlapped == NULL) {
    return;
  }
  context = (cy_resolve_context *)((unsigned char *)overlapped -
                                   offsetof(cy_resolve_context, overlapped));
  InterlockedExchange(&context->completion_error, (LONG)error);
  SetEvent(context->complete_event);
  cy_release_resolve_context(context);
}

static int cy_utf8_to_wide(const char *text, wchar_t *destination,
                           size_t capacity) {
  int required;
  if (text == NULL || destination == NULL || capacity == 0 ||
      capacity > (size_t)INT_MAX) {
    return 0;
  }
  required = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text, -1,
                                 destination, (int)capacity);
  return required > 0;
}

int cy_net_startup(int *error_code) {
  WSADATA data;
  int result;
  memset(&data, 0, sizeof(data));
  result = WSAStartup(MAKEWORD(2, 2), &data);
  if (result != 0) {
    cy_store_error(error_code, result);
    return 0;
  }
  if (LOBYTE(data.wVersion) != 2 || HIBYTE(data.wVersion) != 2) {
    WSACleanup();
    cy_store_error(error_code, WSAVERNOTSUPPORTED);
    return 0;
  }
  cy_store_error(error_code, 0);
  return 1;
}

void cy_net_cleanup(void) {
  WSACleanup();
}

int cy_net_resolve(const char *host, uint16_t port, int socket_type,
                   int passive, cy_net_address *addresses, size_t capacity,
                   int *error_code) {
  ADDRINFOEXW hints;
  PADDRINFOEXW current;
  cy_resolve_context *context;
  wchar_t wide_host[256];
  wchar_t service[16];
  PCWSTR node;
  HANDLE cancel_handle = NULL;
  size_t copied = 0;
  int result;

  if (addresses == NULL || capacity == 0 ||
      capacity > CY_NET_MAX_RESOLVED_ADDRESSES ||
      (socket_type != CY_NET_SOCKET_STREAM &&
       socket_type != CY_NET_SOCKET_DATAGRAM)) {
    cy_store_error(error_code, WSAEINVAL);
    return -1;
  }

  memset(&hints, 0, sizeof(hints));
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = cy_socket_type_value(socket_type);
  hints.ai_protocol = cy_protocol_value(socket_type);
  hints.ai_flags = passive ? AI_PASSIVE : 0;
  (void)_snwprintf_s(service, sizeof(service) / sizeof(service[0]), _TRUNCATE,
                     L"%u", (unsigned int)port);
  node = NULL;
  if (host != NULL && host[0] != '\0') {
    if (!cy_utf8_to_wide(host, wide_host,
                         sizeof(wide_host) / sizeof(wide_host[0]))) {
      cy_store_error(error_code, WSAEINVAL);
      return -1;
    }
    node = wide_host;
  }

  context = (cy_resolve_context *)calloc(1, sizeof(*context));
  if (context == NULL) {
    cy_store_error(error_code, WSA_NOT_ENOUGH_MEMORY);
    return -1;
  }
  context->complete_event = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (context->complete_event == NULL) {
    result = (int)GetLastError();
    free(context);
    cy_store_error(error_code, result);
    return -1;
  }
  context->references = 2;
  {
    WSADATA resolver_data;
    result = WSAStartup(MAKEWORD(2, 2), &resolver_data);
    if (result != 0) {
      CloseHandle(context->complete_event);
      free(context);
      cy_store_error(error_code, result);
      return -1;
    }
    context->owns_winsock_reference = 1;
  }

  result = GetAddrInfoExW(node, service, NS_ALL, NULL, &hints,
                          &context->results, NULL, &context->overlapped,
                          cy_resolve_completed, &cancel_handle);
  if (result == WSA_IO_PENDING) {
    const DWORD wait_result =
        WaitForSingleObject(context->complete_event,
                            CY_NET_RESOLVE_TIMEOUT_MS);
    if (wait_result == WAIT_OBJECT_0) {
      result = (int)context->completion_error;
    } else {
      if (cancel_handle != NULL) {
        (void)GetAddrInfoExCancel(&cancel_handle);
      }
      result = wait_result == WAIT_TIMEOUT ? WSAETIMEDOUT : WSAEINVAL;
      cy_store_error(error_code, result);
      /* The completion callback owns the operation reference and will free
       * the context even when a legacy name provider finishes after return. */
      cy_release_resolve_context(context);
      return -1;
    }
  } else {
    /* A non-pending call does not invoke the asynchronous callback. */
    InterlockedExchange(&context->completion_error, (LONG)result);
    cy_release_resolve_context(context);
  }

  if (result != 0) {
    cy_store_error(error_code, result);
    cy_release_resolve_context(context);
    return -1;
  }

  for (current = context->results; current != NULL && copied < capacity;
       current = current->ai_next) {
    if ((current->ai_family != AF_INET && current->ai_family != AF_INET6) ||
        current->ai_addrlen > (size_t)INT_MAX) {
      continue;
    }
    if (cy_copy_sockaddr(&addresses[copied], current->ai_addr,
                         (int)current->ai_addrlen, current->ai_socktype,
                         current->ai_protocol)) {
      ++copied;
    }
  }
  cy_release_resolve_context(context);
  if (copied == 0) {
    cy_store_error(error_code, WSAEAFNOSUPPORT);
    return -1;
  }
  cy_store_error(error_code, 0);
  return (int)copied;
}

cy_net_socket cy_net_open_socket(const cy_net_address *address,
                                 int *error_code) {
  SOCKET result;
  if (address == NULL || address->length <= 0) {
    cy_store_error(error_code, WSAEINVAL);
    return CY_NET_INVALID_SOCKET;
  }
  result = socket(address->family, address->socket_type, address->protocol);
  if (result == INVALID_SOCKET) {
    cy_store_error(error_code, WSAGetLastError());
    return CY_NET_INVALID_SOCKET;
  }
  cy_store_error(error_code, 0);
  return cy_public_socket(result);
}

int cy_net_set_nonblocking(cy_net_socket socket_value, int enabled,
                           int *error_code) {
  u_long value = enabled ? 1UL : 0UL;
  if (ioctlsocket(cy_native_socket(socket_value), FIONBIO, &value) ==
      SOCKET_ERROR) {
    cy_store_error(error_code, WSAGetLastError());
    return 0;
  }
  cy_store_error(error_code, 0);
  return 1;
}

int cy_net_set_exclusive_address_use(cy_net_socket socket_value,
                                     int *error_code) {
  const BOOL enabled = TRUE;
  if (setsockopt(cy_native_socket(socket_value), SOL_SOCKET,
                 SO_EXCLUSIVEADDRUSE, (const char *)&enabled,
                 (int)sizeof(enabled)) == SOCKET_ERROR) {
    cy_store_error(error_code, WSAGetLastError());
    return 0;
  }
  cy_store_error(error_code, 0);
  return 1;
}

int cy_net_bind(cy_net_socket socket_value, const cy_net_address *address,
                int *error_code) {
  if (address == NULL ||
      bind(cy_native_socket(socket_value),
           (const struct sockaddr *)address->storage.bytes, address->length) ==
          SOCKET_ERROR) {
    cy_store_error(error_code,
                   address == NULL ? WSAEINVAL : WSAGetLastError());
    return 0;
  }
  cy_store_error(error_code, 0);
  return 1;
}

int cy_net_listen(cy_net_socket socket_value, int backlog, int *error_code) {
  if (listen(cy_native_socket(socket_value), backlog) == SOCKET_ERROR) {
    cy_store_error(error_code, WSAGetLastError());
    return 0;
  }
  cy_store_error(error_code, 0);
  return 1;
}

int cy_net_connect(cy_net_socket socket_value, const cy_net_address *address,
                   int *error_code) {
  int error;
  if (address == NULL) {
    cy_store_error(error_code, WSAEINVAL);
    return CY_NET_RESULT_ERROR;
  }
  if (connect(cy_native_socket(socket_value),
              (const struct sockaddr *)address->storage.bytes,
              address->length) == 0) {
    cy_store_error(error_code, 0);
    return CY_NET_RESULT_OK;
  }
  error = WSAGetLastError();
  cy_store_error(error_code, error);
  if (error == WSAEWOULDBLOCK || error == WSAEINPROGRESS ||
      error == WSAEALREADY) {
    return CY_NET_RESULT_IN_PROGRESS;
  }
  return CY_NET_RESULT_ERROR;
}

cy_net_socket cy_net_accept(cy_net_socket listener, cy_net_address *peer,
                            int *result, int *error_code) {
  struct sockaddr_storage storage;
  int length = (int)sizeof(storage);
  SOCKET accepted;
  int error;
  memset(&storage, 0, sizeof(storage));
  accepted = accept(cy_native_socket(listener), (struct sockaddr *)&storage,
                    &length);
  if (accepted == INVALID_SOCKET) {
    error = WSAGetLastError();
    cy_store_error(error_code, error);
    if (result != NULL) {
      *result = error == WSAEWOULDBLOCK ? CY_NET_RESULT_WOULD_BLOCK
                                       : CY_NET_RESULT_ERROR;
    }
    return CY_NET_INVALID_SOCKET;
  }
  if (peer != NULL) {
    cy_copy_sockaddr(peer, (const struct sockaddr *)&storage, length,
                     SOCK_STREAM, IPPROTO_TCP);
  }
  cy_store_error(error_code, 0);
  if (result != NULL) {
    *result = CY_NET_RESULT_OK;
  }
  return cy_public_socket(accepted);
}

int cy_net_wait(cy_net_poll_entry *entries, size_t count, int timeout_ms,
                int *error_code) {
  fd_set read_set;
  fd_set write_set;
  fd_set exception_set;
  struct timeval timeout;
  size_t index;
  int result;

  if ((entries == NULL && count != 0) || count >= FD_SETSIZE ||
      timeout_ms < 0) {
    cy_store_error(error_code, WSAEINVAL);
    return CY_NET_RESULT_ERROR;
  }

  FD_ZERO(&read_set);
  FD_ZERO(&write_set);
  FD_ZERO(&exception_set);
  for (index = 0; index < count; ++index) {
    entries[index].readable = 0;
    entries[index].writable = 0;
    entries[index].exceptional = 0;
    if (entries[index].socket == CY_NET_INVALID_SOCKET) {
      continue;
    }
    if (entries[index].want_read) {
      FD_SET(cy_native_socket(entries[index].socket), &read_set);
    }
    if (entries[index].want_write) {
      FD_SET(cy_native_socket(entries[index].socket), &write_set);
    }
    FD_SET(cy_native_socket(entries[index].socket), &exception_set);
  }

  timeout.tv_sec = timeout_ms / 1000;
  timeout.tv_usec = (timeout_ms % 1000) * 1000;
  result = select(0, &read_set, &write_set, &exception_set, &timeout);
  if (result == SOCKET_ERROR) {
    cy_store_error(error_code, WSAGetLastError());
    return CY_NET_RESULT_ERROR;
  }
  for (index = 0; index < count; ++index) {
    const SOCKET socket_value = cy_native_socket(entries[index].socket);
    entries[index].readable = FD_ISSET(socket_value, &read_set) ? 1 : 0;
    entries[index].writable = FD_ISSET(socket_value, &write_set) ? 1 : 0;
    entries[index].exceptional =
        FD_ISSET(socket_value, &exception_set) ? 1 : 0;
  }
  cy_store_error(error_code, 0);
  return result;
}

static int cy_net_transfer_result(int result, size_t *size_value,
                                  int *error_code) {
  int error;
  if (result > 0) {
    if (size_value != NULL) {
      *size_value = (size_t)result;
    }
    cy_store_error(error_code, 0);
    return CY_NET_RESULT_OK;
  }
  if (result == 0) {
    if (size_value != NULL) {
      *size_value = 0;
    }
    cy_store_error(error_code, 0);
    return CY_NET_RESULT_CLOSED;
  }
  error = WSAGetLastError();
  cy_store_error(error_code, error);
  if (size_value != NULL) {
    *size_value = 0;
  }
  return error == WSAEWOULDBLOCK ? CY_NET_RESULT_WOULD_BLOCK
                                 : CY_NET_RESULT_ERROR;
}

int cy_net_send(cy_net_socket socket_value, const unsigned char *data,
                size_t size, size_t *sent, int *error_code) {
  int request_size;
  int result;
  if ((data == NULL && size != 0) || size > (size_t)INT_MAX) {
    cy_store_error(error_code, WSAEINVAL);
    return CY_NET_RESULT_ERROR;
  }
  request_size = (int)size;
  result = send(cy_native_socket(socket_value), (const char *)data,
                request_size, 0);
  return cy_net_transfer_result(result, sent, error_code);
}

int cy_net_send_to(cy_net_socket socket_value, const unsigned char *data,
                   size_t size, const cy_net_address *target, size_t *sent,
                   int *error_code) {
  int result;
  if ((data == NULL && size != 0) || size > (size_t)INT_MAX ||
      target == NULL) {
    cy_store_error(error_code, WSAEINVAL);
    return CY_NET_RESULT_ERROR;
  }
  result = sendto(cy_native_socket(socket_value), (const char *)data,
                  (int)size, 0,
                  (const struct sockaddr *)target->storage.bytes, target->length);
  return cy_net_transfer_result(result, sent, error_code);
}

int cy_net_receive(cy_net_socket socket_value, unsigned char *data,
                   size_t capacity, size_t *received, int *error_code) {
  int result;
  if (data == NULL || capacity == 0 || capacity > (size_t)INT_MAX) {
    cy_store_error(error_code, WSAEINVAL);
    return CY_NET_RESULT_ERROR;
  }
  result = recv(cy_native_socket(socket_value), (char *)data, (int)capacity, 0);
  return cy_net_transfer_result(result, received, error_code);
}

int cy_net_receive_from(cy_net_socket socket_value, unsigned char *data,
                        size_t capacity, size_t *received,
                        cy_net_address *peer, int *error_code) {
  struct sockaddr_storage storage;
  int length = (int)sizeof(storage);
  int result;
  if (data == NULL || capacity == 0 || capacity > (size_t)INT_MAX) {
    cy_store_error(error_code, WSAEINVAL);
    return CY_NET_RESULT_ERROR;
  }
  memset(&storage, 0, sizeof(storage));
  result = recvfrom(cy_native_socket(socket_value), (char *)data,
                    (int)capacity, 0, (struct sockaddr *)&storage, &length);
  if (result >= 0 && peer != NULL) {
    cy_copy_sockaddr(peer, (const struct sockaddr *)&storage, length,
                     SOCK_DGRAM, IPPROTO_UDP);
  }
  /* A zero-length UDP datagram is data, not a closed connection. */
  if (result == 0) {
    if (received != NULL) {
      *received = 0;
    }
    cy_store_error(error_code, 0);
    return CY_NET_RESULT_OK;
  }
  return cy_net_transfer_result(result, received, error_code);
}

int cy_net_socket_error(cy_net_socket socket_value, int *socket_error,
                        int *error_code) {
  int value = 0;
  int length = (int)sizeof(value);
  if (socket_error == NULL ||
      getsockopt(cy_native_socket(socket_value), SOL_SOCKET, SO_ERROR,
                 (char *)&value, &length) == SOCKET_ERROR) {
    cy_store_error(error_code,
                   socket_error == NULL ? WSAEINVAL : WSAGetLastError());
    return 0;
  }
  *socket_error = value;
  cy_store_error(error_code, 0);
  return 1;
}

static int cy_net_endpoint(cy_net_socket socket_value, int peer,
                           cy_net_address *address, int *error_code) {
  struct sockaddr_storage storage;
  int length = (int)sizeof(storage);
  int result;
  if (address == NULL) {
    cy_store_error(error_code, WSAEINVAL);
    return 0;
  }
  memset(&storage, 0, sizeof(storage));
  result = peer ? getpeername(cy_native_socket(socket_value),
                              (struct sockaddr *)&storage, &length)
                : getsockname(cy_native_socket(socket_value),
                              (struct sockaddr *)&storage, &length);
  if (result == SOCKET_ERROR) {
    cy_store_error(error_code, WSAGetLastError());
    return 0;
  }
  if (!cy_copy_sockaddr(address, (const struct sockaddr *)&storage, length,
                        0, 0)) {
    cy_store_error(error_code, WSAEAFNOSUPPORT);
    return 0;
  }
  cy_store_error(error_code, 0);
  return 1;
}

int cy_net_local_address(cy_net_socket socket_value, cy_net_address *address,
                         int *error_code) {
  return cy_net_endpoint(socket_value, 0, address, error_code);
}

int cy_net_peer_address(cy_net_socket socket_value, cy_net_address *address,
                        int *error_code) {
  return cy_net_endpoint(socket_value, 1, address, error_code);
}

int cy_net_address_text(const cy_net_address *address, char *host,
                        size_t host_capacity, uint16_t *port,
                        int *error_code) {
  char service[16];
  int result;
  unsigned long parsed_port;
  if (address == NULL || host == NULL || host_capacity == 0 ||
      host_capacity > (size_t)UINT32_MAX || port == NULL) {
    cy_store_error(error_code, WSAEINVAL);
    return 0;
  }
  service[0] = '\0';
  result = getnameinfo((const struct sockaddr *)address->storage.bytes,
                       address->length, host, (DWORD)host_capacity, service,
                       (DWORD)sizeof(service), NI_NUMERICHOST | NI_NUMERICSERV);
  if (result != 0) {
    cy_store_error(error_code, result);
    return 0;
  }
  parsed_port = strtoul(service, NULL, 10);
  if (parsed_port > 65535UL) {
    cy_store_error(error_code, WSAEINVAL);
    return 0;
  }
  *port = (uint16_t)parsed_port;
  cy_store_error(error_code, 0);
  return 1;
}

int cy_net_address_is_loopback(const cy_net_address *address) {
  const struct sockaddr *generic;
  if (address == NULL) {
    return 0;
  }
  generic = (const struct sockaddr *)address->storage.bytes;
  if (generic->sa_family == AF_INET) {
    const struct sockaddr_in *ipv4 =
        (const struct sockaddr_in *)address->storage.bytes;
    const uint32_t value = ntohl(ipv4->sin_addr.s_addr);
    return (value & 0xff000000UL) == 0x7f000000UL;
  }
  if (generic->sa_family == AF_INET6) {
    const struct sockaddr_in6 *ipv6 =
        (const struct sockaddr_in6 *)address->storage.bytes;
    return IN6_IS_ADDR_LOOPBACK(&ipv6->sin6_addr) ? 1 : 0;
  }
  return 0;
}

int cy_net_address_is_any(const cy_net_address *address) {
  const struct sockaddr *generic;
  if (address == NULL) {
    return 0;
  }
  generic = (const struct sockaddr *)address->storage.bytes;
  if (generic->sa_family == AF_INET) {
    const struct sockaddr_in *ipv4 =
        (const struct sockaddr_in *)address->storage.bytes;
    return ipv4->sin_addr.s_addr == htonl(INADDR_ANY);
  }
  if (generic->sa_family == AF_INET6) {
    const struct sockaddr_in6 *ipv6 =
        (const struct sockaddr_in6 *)address->storage.bytes;
    return IN6_IS_ADDR_UNSPECIFIED(&ipv6->sin6_addr) ? 1 : 0;
  }
  return 0;
}

int cy_net_address_family(const cy_net_address *address) {
  if (address == NULL) {
    return 0;
  }
  if (address->family == AF_INET) {
    return 4;
  }
  if (address->family == AF_INET6) {
    return 6;
  }
  return 0;
}

void cy_net_shutdown(cy_net_socket socket_value) {
  if (socket_value != CY_NET_INVALID_SOCKET) {
    shutdown(cy_native_socket(socket_value), SD_BOTH);
  }
}

void cy_net_close(cy_net_socket socket_value) {
  if (socket_value != CY_NET_INVALID_SOCKET) {
    closesocket(cy_native_socket(socket_value));
  }
}

int cy_net_last_error(void) {
  return WSAGetLastError();
}
