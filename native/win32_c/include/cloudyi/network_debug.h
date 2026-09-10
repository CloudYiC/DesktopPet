/* Winsock primitives used by the desktop network debugging service. */
#ifndef CLOUDYI_NETWORK_DEBUG_H
#define CLOUDYI_NETWORK_DEBUG_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Large enough for a Windows SOCKADDR_STORAGE without exposing Winsock. */
#define CY_NET_ADDRESS_STORAGE_SIZE 128
#define CY_NET_MAX_RESOLVED_ADDRESSES 16

typedef uintptr_t cy_net_socket;

#define CY_NET_INVALID_SOCKET ((cy_net_socket)(~(uintptr_t)0))

enum cy_net_socket_type {
  CY_NET_SOCKET_STREAM = 1,
  CY_NET_SOCKET_DATAGRAM = 2
};

enum cy_net_result {
  CY_NET_RESULT_ERROR = -1,
  CY_NET_RESULT_OK = 0,
  CY_NET_RESULT_WOULD_BLOCK = 1,
  CY_NET_RESULT_IN_PROGRESS = 2,
  CY_NET_RESULT_CLOSED = 3
};

typedef union cy_net_address_storage {
  uintptr_t alignment;
  unsigned char bytes[CY_NET_ADDRESS_STORAGE_SIZE];
} cy_net_address_storage;

typedef struct cy_net_address {
  cy_net_address_storage storage;
  int length;
  int family;
  int socket_type;
  int protocol;
} cy_net_address;

typedef struct cy_net_poll_entry {
  cy_net_socket socket;
  int want_read;
  int want_write;
  int readable;
  int writable;
  int exceptional;
} cy_net_poll_entry;

/* Initializes Winsock 2.2 for the calling process. */
int cy_net_startup(int *error_code);

/* Balances one successful call to cy_net_startup. */
void cy_net_cleanup(void);

/*
 * Resolves a numeric address or host name. `passive` selects bind semantics;
 * an empty passive host resolves to wildcard addresses. The number of copied
 * addresses is returned, or -1 on failure.
 */
int cy_net_resolve(const char *host, uint16_t port, int socket_type,
                   int passive, cy_net_address *addresses, size_t capacity,
                   int *error_code);

cy_net_socket cy_net_open_socket(const cy_net_address *address,
                                 int *error_code);
int cy_net_set_nonblocking(cy_net_socket socket, int enabled,
                           int *error_code);
int cy_net_set_exclusive_address_use(cy_net_socket socket,
                                     int *error_code);
int cy_net_bind(cy_net_socket socket, const cy_net_address *address,
                int *error_code);
int cy_net_listen(cy_net_socket socket, int backlog, int *error_code);
int cy_net_connect(cy_net_socket socket, const cy_net_address *address,
                   int *error_code);
cy_net_socket cy_net_accept(cy_net_socket listener, cy_net_address *peer,
                            int *result, int *error_code);

/* Waits for readiness on at most FD_SETSIZE sockets. */
int cy_net_wait(cy_net_poll_entry *entries, size_t count, int timeout_ms,
                int *error_code);

int cy_net_send(cy_net_socket socket, const unsigned char *data, size_t size,
                size_t *sent, int *error_code);
int cy_net_send_to(cy_net_socket socket, const unsigned char *data,
                   size_t size, const cy_net_address *target, size_t *sent,
                   int *error_code);
int cy_net_receive(cy_net_socket socket, unsigned char *data, size_t capacity,
                   size_t *received, int *error_code);
int cy_net_receive_from(cy_net_socket socket, unsigned char *data,
                        size_t capacity, size_t *received,
                        cy_net_address *peer, int *error_code);

int cy_net_socket_error(cy_net_socket socket, int *socket_error,
                        int *error_code);
int cy_net_local_address(cy_net_socket socket, cy_net_address *address,
                         int *error_code);
int cy_net_peer_address(cy_net_socket socket, cy_net_address *address,
                        int *error_code);
int cy_net_address_text(const cy_net_address *address, char *host,
                        size_t host_capacity, uint16_t *port,
                        int *error_code);
int cy_net_address_is_loopback(const cy_net_address *address);
int cy_net_address_is_any(const cy_net_address *address);
int cy_net_address_family(const cy_net_address *address);

void cy_net_shutdown(cy_net_socket socket);
void cy_net_close(cy_net_socket socket);
int cy_net_last_error(void);

#ifdef __cplusplus
}
#endif

#endif /* CLOUDYI_NETWORK_DEBUG_H */
