#!/usr/bin/env nodejs

/*

This script generates markdown files for libdill documentation.
These are further processed to generate both UNIX and HTML man pages.

Schema:

    name: name of the function
    info: short description of the function
    is_in_libdillimpl: if true, the function is in libdillimpl.h
    protocol : { // should be present only if the function is related
                 // to a network protocol
        name: name of the protocol
        info: description of the protocol
        example: example of usage of the protocol, a piece of C code
    }
    result: { // omit this field for void functions
        type: return type of the function
    }
    args: [ // may be ommited for functions with no arguments
        {
            name: name of the argument
            type: type of the argument
            info: description of the argument
        }
    ]
    add_to_synopsis: a piece of code to be added to synopsis, between the
                     include and the function declaration
    has_iol: if true, adds I/O list to the list of arguments
    has_deadline: if true, adds deadline to the list of arguments
    has_handle_argument: set to true if at least one of the arguments is
                         a handle
    allocates_handle: set to true is the function allocates at least one handle
    prologue: the part of the description of the function to go before the list
              of arguments
    epilogue: the part of the description of the function to go after the list
              of arguments
    errors: a list of possible errors, the descriptions will be pulled from
            standard_errors object
    custom_errors: [{ // custom errors take precedence over standard errors
        error name: error description
    }]
    example: example of the usage of the function, a piece of C code;
             if present, overrides the protocol example
    mem: size // if set, _mem variant of the function will be generated;
              // size if the size macro such as TCP_SIZE or UDP_SIZE
*/

var fs = require('fs');

standard_errors = {
    EBADF: "Invalid socket handle.",
    ETIMEDOUT: "Deadline was reached.",
    ENOMEM: "Not enough memory.",
    EMFILE: "The maximum number of file descriptors in the process are " +
            "already open.",
    ENFILE: "The maximum number of file descriptors in the system are " +
            "already open.",
    EINVAL: "Invalid argument.",
    EMSGSIZE: "The data won't fit into the supplied buffer.",
    ECONNRESET: "Broken connection.",
    ECANCELED: "Current coroutine is in the process of shutting down.",
    ENOTSUP: "The handle does not support this operation.",
}

crlf_protocol = {
    name: "CRLF",
    info: `
        CRLF is a message-based protocol that delimits messages usign CR+LF byte
        sequence (0x0D 0x0A). In other words, it's a protocol to send text
        messages separated by newlines. The protocol has no initial handshake.
        Terminal handshake is accomplished by each peer sending an empty line.
    `,
    example: `
        int s = tcp_connect(&addr, -1);
        s = crlf_attach(s);
        msend(s, "ABC", 3, -1);
        char buf[256];
        ssize_t sz = mrecv(s, buf, sizeof(buf), -1);
        s = crlf_detach(s, -1);
        tcp_close(s);
    `,
}

http_protocol = {
    name: "HTTP",
    info: `
        HTTP is an application-level protocol described in RFC 7230. This
        implementation handles only the request/response exchange. Whatever
        comes after that must be handled by a different protocol.
    `,
    example: `
        int s = tcp_connect(&addr, -1);
        s = http_attach(s);
        http_sendrequest(s, "GET", "/", -1);
        http_sendfield(s, "Host", "www.example.org", -1);
        hdone(s, -1);
        char reason[256];
        http_recvstatus(s, reason, sizeof(reason), -1);
        while(1) {
            char name[256];
            char value[256];
            int rc = http_recvfield(s, name, sizeof(name), value, sizeof(value), -1);
            if(rc == -1 && errno == EPIPE) break;
        }
        s = http_detach(s, -1);
        tcp_close(s);
    `,
    experimental: true,
}

http_server_example = `
    int s = tcp_accept(listener, NULL, -1);
    s = http_attach(s, -1);
    char command[256];
    char resource[256];
    http_recvrequest(s, command, sizeof(command), resource, sizeof(resource), -1);
    while(1) {
        char name[256];
        char value[256];
        int rc = http_recvfield(s, name, sizeof(name), value, sizeof(value), -1);
        if(rc == -1 && errno == EPIPE) break;
    }
    http_sendstatus(s, 200, "OK", -1);
    s = http_detach(s, -1); 
    tcp_close(s);
`

pfx_protocol = {
    name: "PFX",
    info: `
        PFX  is a message-based protocol to send binary messages prefixed by
        8-byte size in network byte order. The protocol has no initial
        handshake. Terminal handshake is accomplished by each peer sending eight
        0xFF bytes.
    `,
    example: `
        int s = tcp_connect(&addr, -1);
        s = pfx_attach(s);
        msend(s, "ABC", 3, -1);
        char buf[256];
        ssize_t sz = mrecv(s, buf, sizeof(buf), -1);
        s = pfx_detach(s, -1);
        tcp_close(s);
    `
}

tls_protocol = {
    name: "TLS",
    info: `
        TLS is a cryptographic protocol to provide secure communication over
        the network. It is a bytestream protocol.
    `,
    example: `
        int s = tcp_connect(&addr, -1);
        s = tls_attach_client(s, -1);
        bsend(s, "ABC", 3, -1);
        char buf[3];
        ssize_t sz = brecv(s, buf, sizeof(buf), -1);
        s = tls_detach(s, -1);
        tcp_close(s);
    `,
    experimental: true,
}

udp_protocol = {
    name: "UDP",
    info: `
        UDP is an unreliable message-based protocol defined in RFC 768. The size
        of the message is limited. The protocol has no initial or terminal
        handshake. A single socket can be used to different destinations.
    `,
    example: `
        struct ipaddr local;
        ipaddr_local(&local, NULL, 5555, 0);
        struct ipaddr remote;
        ipaddr_remote(&remote, "server.example.org", 5555, 0, -1);
        int s = udp_open(&local, &remote);
        udp_send(s1, NULL, "ABC", 3);
        char buf[2000];
        ssize_t sz = udp_recv(s, NULL, buf, sizeof(buf), -1);
        hclose(s);
    `,
}

fxs = [
    {
        name: "crlf_attach",
        info: "creates CRLF protocol on top of underlying socket",
        result: {
            type: "int",
            success: "newly created socket handle",
            error: "-1",
        },
        args: [
           {
               name: "s",
               type: "int",
               info: "Handle of the underlying socket. It must be a " +
                     "bytestream protocol.",
           },
        ],
        protocol: crlf_protocol,
        prologue: `
            This function instantiates CRLF protocol on top of the underlying
            protocol.
        `,
        epilogue: `
            The socket can be cleanly shut down using **crlf_detach** function.
        `,
        has_handle_argument: true,
        allocates_handle: true,
        mem: "CRLF_SIZE",
        custom_errors: {
            EPROTO: "Underlying socket is not a bytestream socket.",
        },
    },
    {
        name: "crlf_detach",
        info: "terminates CRLF protocol and returns the underlying socket",

        result: {
            type: "int",
            success: "underlying socket handle",
            error: "-1",
        },
        args: [
           {
               name: "s",
               type: "int",
               info: "Handle of the CRLF socket.",
           },
        ],
        protocol: crlf_protocol,
        prologue: `
            This function does the terminal handshake and returns underlying
            socket to the user. The socket is closed even in the case of error.
        `,
        has_handle_argument: true,
        has_deadline: true,
        uses_connection: true,

        custom_errors: {
            ENOTSUP: "The handle is not a CRLF protocol handle.",
        },
    },
    {
        name: "hdup",
        info: "duplicates a handle",

        result: {
            type: "int",
            success: "newly duplicated handle",
            error: "-1",
        },
        args: [
            {
                name: "h",
                type: "int",
                info: "Handle to duplicate.",
            }
        ],

        allocates_handle: true,

        prologue: `
            Duplicates a handle. The new handle will refer to the same
            underlying object.
        `,
        epilogue: `
            Each duplicate of a handle requires its own call to **hclose**.
            The underlying object is deallocated when all handles pointing to it
            have been closed.
        `,
        errors: ["EBADF"],
    },
    {
        name: "hmake",
        info: "creates a handle",
        is_in_libdillimpl: true,
        add_to_synopsis: `
            struct hvfs {
                void *(*query)(struct hvfs *vfs, const void *type);
                void (*close)(int h);
                int (*done)(struct hvfs *vfs, int64_t deadline);
            };
        `,
        result: {
            type: "int",
            success: "newly created handle",
            error: "-1",
        },
        args: [
            {
                name: "hvfs",
                type: "struct hvfs*",
                info: "virtual-function table of operations associated with " +
                      "the handle",
            }
        ],

        prologue: `
            A handle is the user-space equivalent of a file descriptor.
            Coroutines and channels are represented by handles.

            Unlike with file descriptors, however, you can use the **hmake**
            function to create your own type of handle.

            The argument of the function is a virtual-function table of
            operations associated with the handle.

            When implementing the **close** operation, keep in mind that
            invoking blocking operations is not allowed, as blocking operations
            invoked within the context of a **close** operation will fail with
            an **ECANCELED** error.

            To close a handle, use the **hclose** function.
        `,

        errors: ["ECANCELED", "EINVAL", "ENOMEM"],
    },
    {
        name: "http_attach",
        info: "creates HTTP protocol on top of underlying socket",
        result: {
            type: "int",
            success: "newly created socket handle",
            error: "-1",
        },
        args: [
           {
               name: "s",
               type: "int",
               info: "Handle of the underlying socket. It must be a " +
                     "bytestream protocol.",
           },
        ],
        protocol: http_protocol,
        prologue: `
            This function instantiates HTTP protocol on top of the underlying
            protocol.
        `,
        epilogue: `
            The socket can be cleanly shut down using **http_detach** function.
        `,
        has_handle_argument: true,
        allocates_handle: true,
        mem: "HTTP_SIZE",

        custom_errors: {
            EPROTO: "Underlying socket is not a bytestream socket.",
        },
    },
    {
        name: "http_detach",
        info: "terminates HTTP protocol and returns the underlying socket",
        result: {
            type: "int",
            success: "underlying socket handle",
            error: "-1",
        },
        args: [
           {
               name: "s",
               type: "int",
               info: "Handle of the CRLF socket.",
           },
        ],
        protocol: http_protocol,
        prologue: `
            This function does the terminal handshake and returns underlying
            socket to the user. The socket is closed even in the case of error.
        `,

        has_handle_argument: true,
        has_deadline: true,
        uses_connection: true,

        custom_errors: {
            ENOTSUP: "The handle is not an HTTP protocol handle.",
        },
    },
    {
        name: "http_recvfield",
        info: "receives HTTP field from the peer",
        result: {
            type: "int",
            success: "0",
            error: "-1",
        },
        args: [
           {
               name: "s",
               type: "int",
               info: "HTTP socket handle.",
           },
           {
               name: "name",
               type: "char*",
               info: "Buffer to store name of the field.",
           },
           {
               name: "namelen",
               type: "size_t",
               info: "Size of the **name** buffer.",
           },
           {
               name: "value",
               type: "char*",
               info: "Buffer to store value of the field.",
           },
           {
               name: "valuelen",
               type: "size_t",
               info: "Size of the **value** buffer.",
           },
        ],
        protocol: http_protocol,
        prologue: "This function receives an HTTP field from the peer.",
        has_handle_argument: true,
        has_deadline: true,
        uses_connection: true,

        errors: ["EINVAL", "EMSGSIZE"],
        custom_errors: {
            EPIPE: "There are no more fields to receive."
        }
    },
    {
        name: "http_recvrequest",
        info: "receives HTTP request from the peer",
        result: {
            type: "int",
            success: "0",
            error: "-1",
        },
        args: [
           {
               name: "s",
               type: "int",
               info: "HTTP socket handle.",
           },
           {
               name: "command",
               type: "char*",
               info: "Buffer to store HTTP command in.",
           },
           {
               name: "commandlen",
               type: "size_t",
               info: "Size of the **command** buffer.",
           },
           {
               name: "resource",
               type: "char*",
               info: "Buffer to store HTTP resource in.",
           },
           {
               name: "resourcelen",
               type: "size_t",
               info: "Size of the **resource** buffer.",
           },
        ],
        protocol: http_protocol,
        prologue: "This function receives an HTTP request from the peer.",
        has_handle_argument: true,
        has_deadline: true,
        uses_connection: true,

        errors: ["EINVAL", "EMSGSIZE"],

        example: http_server_example,
    },
    {
        name: "http_recvstatus",
        info: "receives HTTP status from the peer",
        result: {
            type: "int",
            success: "HTTP status code, such as 200 or 404",
            error: "-1",
        },
        args: [
           {
               name: "s",
               type: "int",
               info: "HTTP socket handle.",
           },
           {
               name: "reason",
               type: "char*",
               info: "Buffer to store reason string in.",
           },
           {
               name: "reasonlen",
               type: "size_t",
               info: "Size of the **reason** buffer.",
           },
        ],
        protocol: http_protocol,
        prologue: "This function receives an HTTP status line from the peer.",
        has_handle_argument: true,
        has_deadline: true,
        uses_connection: true,

        errors: ["EINVAL", "EMSGSIZE"],
    },
    {
        name: "http_sendfield",
        info: "sends HTTP field to the peer",
        result: {
            type: "int",
            success: "0",
            error: "-1",
        },
        args: [
           {
               name: "s",
               type: "int",
               info: "HTTP socket handle.",
           },
           {
               name: "name",
               type: "const char*",
               info: "Name of the field.",
           },
           {
               name: "value",
               type: "const char*",
               info: "Value of the field.",
           },
        ],
        protocol: http_protocol,
        prologue: `
            This function sends an HTTP field, i.e. a name/value pair, to the
            peer. For example, if name is **Host** and resource is
            **www.example.org** the line sent will look like this:

            \`\`\`
            Host: www.example.org
            \`\`\`

            After sending the last field of HTTP request don't forget to call
            **hdone** on the socket. It will send an empty line to the server to
            let it know that the request is finished and it should start
            processing it.
        `,
        has_handle_argument: true,
        has_deadline: true,
        uses_connection: true,

        errors: ["EINVAL"],
    },
    {
        name: "http_sendrequest",
        info: "sends initial HTTP request",
        result: {
            type: "int",
            success: "0",
            error: "-1",
        },
        args: [
           {
               name: "s",
               type: "int",
               info: "HTTP socket handle.",
           },
           {
               name: "command",
               type: "const char*",
               info: "HTTP command, such as **GET**.",
           },
           {
               name: "resource",
               type: "const char*",
               info: "HTTP resource, such as **/index.html**.",
           },
        ],
        protocol: http_protocol,
        prologue: `
            This function sends an initial HTTP request with the specified
            command and resource.  For example, if command is **GET** and
            resource is **/index.html** the line sent will look like this:

            \`\`\`
            GET /index.html HTTP/1.1
            \`\`\`
        `,
        has_handle_argument: true,
        has_deadline: true,
        uses_connection: true,

        errors: ["EINVAL"],
    },
    {
        name: "http_sendstatus",
        info: "sends HTTP status to the peer",
        result: {
            type: "int",
            success: "0",
            error: "-1",
        },
        args: [
           {
               name: "s",
               type: "int",
               info: "HTTP socket handle.",
           },
           {
               name: "status",
               type: "int",
               info: "HTTP status such as 200 or 404.",
           },
           {
               name: "reason",
               type: "const char*",
               info: "Reason string such as 'OK' or 'Not found'.",
           },
        ],
        protocol: http_protocol,
        prologue: `
            This function sends an HTTP status line to the peer. It is meant to
            be done at the beginning of the HTTP response. For example, if
            status is 404 and reason is 'Not found' the line sent will look like
            this:

            \`\`\`
            HTTP/1.1 404 Not found
            \`\`\`
        `,
        has_handle_argument: true,
        has_deadline: true,
        uses_connection: true,

        errors: ["EINVAL"],

        example: http_server_example,
    },
    {
        name: "now",
        info: "get current time",
        result: {
            type: "int64_t",
            info: "Current time."
        },
        args: [
        ],

        prologue: `
            Returns current time, in milliseconds.

            The function is meant for creating deadlines. For example, a point
            of time one second from now can be expressed as **now() + 1000**.

            The following values have special meaning and cannot be returned by
            the function:

            * 0: Immediate deadline.
            * -1: Infinite deadline.
        `,

        example: `
            int result = chrecv(ch, &val, sizeof(val), now() + 1000);
            if(result == -1 && errno == ETIMEDOUT) {
                printf("One second elapsed without receiving a message.\\n");
            }
        `,
    },
    {
        name: "pfx_attach",
        info: "creates PFX protocol on top of underlying socket",
        result: {
            type: "int",
            success: "newly created socket handle",
            error: "-1",
        },
        args: [
           {
               name: "s",
               type: "int",
               info: "Handle of the underlying socket. It must be a " +
                     "bytestream protocol.",
           },
        ],
        protocol: pfx_protocol,
        prologue: `
            This function instantiates PFX protocol on top of the underlying
            protocol.
        `,
        epilogue: "The socket can be cleanly shut down using **pfx_detach** " +
                  "function.",

        has_handle_argument: true,
        allocates_handle: true,

        mem: "PFX_SIZE",

        custom_errors: {
            EPROTO: "Underlying socket is not a bytestream socket.",
        },
    },
    {
        name: "pfx_detach",
        info: "terminates PFX protocol and returns the underlying socket",
        result: {
            type: "int",
            success: "underlying socket handle",
            error: "-1",
        },
        args: [
           {
               name: "s",
               type: "int",
               info: "Handle of the PFX socket.",
           },
        ],
        protocol: pfx_protocol,
        prologue: `
            This function does the terminal handshake and returns underlying
            socket to the user. The socket is closed even in the case of error.
        `,

        has_handle_argument: true,
        has_deadline: true,
        uses_connection: true,

        custom_errors: {
            ENOTSUP: "The handle is not a PFX protocol handle.",
        },
    },
    {
        name: "tls_attach_client",
        info: "creates TLS protocol on top of underlying socket",
        result: {
            type: "int",
            success: "newly created socket handle",
            error: "-1",
        },
        args: [
           {
               name: "s",
               type: "int",
               info: "Handle of the underlying socket. It must be a " +
                     "bytestream protocol.",
           },
        ],
        protocol: tls_protocol,
        prologue: `
            This function instantiates TLS protocol on top of the underlying
            protocol. TLS protocol being asymmetric, client and server sides are
            intialized in different ways. This particular function initializes
            the client side of the connection.
        `,
        epilogue: `
            The socket can be cleanly shut down using **tls_detach** function.
        `,
        has_handle_argument: true,
        has_deadline: true,
        allocates_handle: true,
        uses_connection: true,

        mem: "TLS_SIZE",

        custom_errors: {
            EPROTO: "Underlying socket is not a bytestream socket.",
        },
    },
    {
        name: "tls_attach_server",
        info: "creates TLS protocol on top of underlying socket",
        result: {
            type: "int",
            success: "newly created socket handle",
            error: "-1",
        },
        args: [
           {
               name: "s",
               type: "int",
               info: "Handle of the underlying socket. It must be a " +
                     "bytestream protocol.",
           },
           {
               name: "cert",
               type: "const char*",
               info: "Filename of the file contianing the certificate.",
           },
           {
               name: "cert",
               type: "const char*",
               info: "Filename of the file contianing the private key.",
           },
        ],
        protocol: tls_protocol,
        prologue: `
            This function instantiates TLS protocol on top of the underlying
            protocol. TLS protocol being asymmetric, client and server sides are
            intialized in different ways. This particular function initializes
            the server side of the connection.
        `,
        epilogue: `
            The socket can be cleanly shut down using **tls_detach** function.
        `,
        has_handle_argument: true,
        has_deadline: true,
        allocates_handle: true,
        uses_connection: true,

        mem: "TLS_SIZE",

        errors: ["EINVAL"],

        custom_errors: {
            EPROTO: "Underlying socket is not a bytestream socket.",
        },

        example: `
            int s = tcp_accept(listener, NULL, -1);
            s = tls_attach_server(s, -1);
            bsend(s, "ABC", 3, -1);
            char buf[3];
            ssize_t sz = brecv(s, buf, sizeof(buf), -1);
            s = tls_detach(s, -1);
            tcp_close(s);
        `,
    },
    {
        name: "tls_detach",
        info: "terminates TLS protocol and returns the underlying socket",
        result: {
            type: "int",
            success: "underlying socket handle",
            error: "-1",
        },
        args: [
           {
               name: "s",
               type: "int",
               info: "Handle of the TLS socket.",
           },
        ],
        protocol: tls_protocol,
        prologue: `
            This function does the terminal handshake and returns underlying
            socket to the user. The socket is closed even in the case of error.
        `,

        has_handle_argument: true,
        has_deadline: true,
        uses_connection: true,

        custom_errors: {
            ENOTSUP: "The handle is not a TLS protocol handle.",
        },
    },
    {
        name: "udp_open",
        info: "opens an UDP socket",
        result: {
            type: "int",
            success: "newly created socket handle",
            error: "-1",
        },
        args: [
           {
               name: "local",
               type: "struct ipaddr*",
               info: "IP  address to be used to set source IP address in " +
                     "outgoing packets. Also, the socket will receive " +
                     "packets sent to this address. If port in the address " +
                     "is set to zero an ephemeral port will be chosen and " +
                     "filled into the local address.",
           },
           {
               name: "remote",
               type: "struct ipaddr*",
               info: "IP address used as default destination for outbound " +
                     "packets. It is used when destination address in " +
                     "**udp_send** function is set to **NULL**. It is also " +
                     "used by **msend** and **mrecv** functions which don't " +
                     "allow to specify the destination address explicitly.",
           },
        ],
        protocol: udp_protocol,
        prologue: "This function creates an UDP socket.",
        epilogue: "To close this socket use **hclose** function.",

        allocates_handle: true,
        mem: "UDP_SIZE",

        errors: ["EINVAL"],
        custom_errors: {
            EADDRINUSE: "The local address is already in use.",
            EADDRNOTAVAIL: "The specified address is not available from the " +
                           "local machine.",
        },
    },
    {
        name: "udp_recv",
        info: "receives an UDP packet",
        result: {
            type: "ssize_t",
            success: "size of the received message, in bytes",
            error: "-1",
        },
        args: [
           {
               name: "s",
               type: "int",
               info: "Handle of the UDP socket.",
           },
           {
               name: "addr",
               type: "struct ipaddr*",
               info: "Out parameter. IP address of the sender of the packet. " +
                     "Can be **NULL**.",
           },
           {
               name: "buf",
               type: "void*",
               info: "Buffer to receive the data to.",
           },
           {
               name: "len",
               type: "size_t",
               info: "Size of the buffer, in bytes.",
           },
        ],
        protocol: udp_protocol,
        prologue: "This function receives a single UDP packet.",

        has_handle_argument: true,
        has_deadline: true,

        errors: ["EINVAL", "EMSGSIZE"],
    },
    {
        name: "udp_recvl",
        info: "receives an UDP packet",
        result: {
            type: "ssize_t",
            success: "size of the received message, in bytes",
            error: "-1",
        },
        args: [
           {
               name: "s",
               type: "int",
               info: "Handle of the UDP socket.",
           },
           {
               name: "addr",
               type: "struct ipaddr*",
               info: "Out parameter. IP address of the sender of the packet. " +
                     "Can be **NULL**.",
           },
        ],
        protocol: udp_protocol,
        prologue: "This function receives a single UDP packet.",

        has_handle_argument: true,
        has_deadline: true,
        has_iol: true,

        errors: ["EINVAL", "EMSGSIZE"],
    },
    {
        name: "udp_send",
        info: "sends an UDP packet",
        result: {
            type: "int",
            success: "0",
            error: "-1",
        },
        args: [
           {
               name: "s",
               type: "int",
               info: "Handle of the UDP socket.",
           },
           {
               name: "addr",
               type: "const struct ipaddr*",
               info: "IP address to send the packet to. If set to **NULL** " +
                     "remote address specified in **udp_open** function will " +
                     "be used.",
           },
           {
               name: "buf",
               type: "const void*",
               info: "Data to send.",
           },
           {
               name: "len",
               type: "size_t",
               info: "Number of bytes to send.",
           },
        ],
        protocol: udp_protocol,
        prologue: `
            This function sends an UDP packet.

            Given that UDP protocol is unreliable the function has no deadline.
            If packet cannot be sent it will be silently dropped.
        `,

        has_handle_argument: true,
        has_deadline: false,

        errors: ["EINVAL", "EMSGSIZE"],
        custom_errors: {
            EMSGSIZE: "The message is too long to fit into an UDP packet.",
        }
    },
    {
        name: "udp_sendl",
        info: "sends an UDP packet",
        result: {
            type: "int",
            success: "0",
            error: "-1",
        },
        args: [
           {
               name: "s",
               type: "int",
               info: "Handle of the UDP socket.",
           },
           {
               name: "addr",
               type: "const struct ipaddr*",
               info: "IP address to send the packet to. If set to **NULL** " +
                     "remote address specified in **udp_open** function will " +
                     "be used.",
           },
        ],
        protocol: udp_protocol,
        prologue: `
            This function sends an UDP packet.

            Given that UDP protocol is unreliable the function has no deadline.
            If packet cannot be sent it will be silently dropped.
        `,

        has_handle_argument: true,
        has_iol: true,

        errors: ["EINVAL", "EMSGSIZE"],
        custom_errors: {
            EMSGSIZE: "The message is too long to fit into an UDP packet.",
        }
    },
    {
        name: "yield",
        info: "yields CPU to other coroutines",
        result: {
            type: "int",
            success: "0",
            error: "-1",
        },
        args: [
        ],

        prologue: `
            By calling this function, you give other coroutines a chance to run.

            You should consider using **yield** when doing lengthy computations
            which don't have natural coroutine switching points such as socket
            or channel operations or msleep.
        `,

        errors: ["ECANCELED"],

        example: `
            for(i = 0; i != 1000000; ++i) {
                expensive_computation();
                yield(); /* Give other coroutines a chance to run. */
            }
        `,
    },
]

// Trims whitespeace around the rectangular area of text.
function trimrect(t) {
    // Trim empty lines at the top and the bottom.
    var lns = t.split("\n")
    var first = lns.findIndex(function(e) {return e.trim().length > 0})
    if(first < 0) first = 0
    var last = lns.slice().reverse().findIndex(function(e) {
        return e.trim().length > 0
    })
    if(last < 0) last = lns.length
    else last = lns.length - last
    var lines = lns.slice(first, last)

    // Determine minimal left indent.
    var indent = -1
    for(var i = 0; i < lines.length; i++) {
        if(lines[i].trim().length == 0) continue
        var n = lines[i].length - lines[i].trimLeft().length
        if(n < indent || indent == -1) indent = n
    }
    // Trim the whitespace from the left and the right.
    lns = []
    for(var i = 0; i < lines.length; i++) {
        lns.push(lines[i].substr(indent).trimRight())
    }
    return lns.join("\n")
}

// Generate man page for one function.
function generate_man_page(fx, mem) {
    var t = "";

    /**************************************************************************/
    /*  NAME                                                                  */
    /**************************************************************************/
    t += "# NAME\n\n"
    t += fx.name
    if(mem) t += "_mem"
    t += " - " + fx.info + "\n\n"

    /**************************************************************************/
    /*  SYNOPSIS                                                              */
    /**************************************************************************/
    t += "# SYNOPSIS\n\n```c\n"
    if(fx.is_in_libdillimpl) {
        t += "#include <libdillimpl.h>\n\n"
    } else {
        t += "#include <libdill.h>\n\n"
    }
    if(fx.add_to_synopsis) {
        t += trimrect(fx.add_to_synopsis) + "\n\n"
    }
    t += fx.result.type + " " + fx.name
    if(mem) t += "_mem"
    t += "("
    var a = fx.args.slice()

    if(fx.has_iol) {
        a.push({
            name: "first",
            type: "struct iolist*",
            info: "Pointer to the first item of a linked list of I/O buffers.",
        })
        a.push({
            name: "last",
            type: "struct iolist*",
            info: "Pointer to the last item of a linked list of I/O buffers.",
        })
    }
    if(mem) {
        a.push({
            name: "mem",
            type: "void*",
            info: "The memory to store the newly created object. It must be " +
                  "at least **" + fx.mem + "** bytes long and must not be " +
                  "deallocated before the object is closed.",
        })
    }
    if(fx.has_deadline) {
        a.push({
            name: "deadline",
            type: "int64_t",
            info: "A point in time when the operation should time out, in " +
                  "milliseconds. Use the **now** function to get your current" +
                  " point in time. 0 means immediate timeout, i.e., perform " +
                  "the operation if possible or return without blocking if " +
                  "not. -1 means no deadline, i.e., the call will block " +
                  "forever if the operation cannot be performed.",
        })
    }

    for(var j = 0; j < a.length; j++) {
        t += a[j].type + " " + a[j].name
        if(j != a.length - 1) t += ", "
    }
    if(a.length == 0 && !fx.has_iol && !mem && !fx.has_deadline) t += "void"
    t += ");\n```\n\n"

    /**************************************************************************/
    /*  DESCRIPTION                                                           */
    /**************************************************************************/
    t += "# DESCRIPTION\n\n"

    if(fx.experimental || (fx.protocol && fx.protocol.experimental)) {
        t += "**WARNING: This is experimental functionality and the API may " +
             "change in the future.**\n\n"
    }

    if(fx.protocol) {
        t += trimrect(fx.protocol.info) + "\n\n"
    }

    if(fx.prologue) {
        t += trimrect(fx.prologue) + "\n\n"
    }

    if(fx.has_iol) {
        t += trimrect(`
            This function accepts a linked list of I/O buffers instead of a
            single buffer. Argument **first** points to the first item in the
            list, **last** points to the last buffer in the list. The list
            represents a single, fragmented message, not a list of multiple
            messages. Structure **iolist** has the following members:

                void *iol_base;          /* Pointer to the buffer. */
                size_t iol_len;          /* Size of the buffer. */
                struct iolist *iol_next; /* Next buffer in the list. */
                int iol_rsvd;            /* Reserved. Must be set to zero. */

            The function returns **EINVAL** error in case the list is malformed
            or if it contains loops.
        ` )+ "\n\n"
    }

    if(mem) {
        t += trimrect(`
            This function allows to avoid one dynamic memory allocation by
            storing the object in user-supplied memory. Unless you are
            hyper-optimizing use **
        ` + fx.name + "** instead.") + "\n\n"
    }

    for(var j = 0; j < a.length; j++) {
        arg = a[j]
        t += "**" + arg.name + "**: " + arg.info + "\n\n"
    }

    if(fx.epilogue) {
        t += trimrect(fx.epilogue) + "\n\n"
    }

    if(fx.protocol) {
        t += "This function is not available if libdill is compiled with " +
             "**--disable-sockets** option.\n\n"
        if(fx.protocol.name == "TLS") {
            t += "This function is not available if libdill is compiled " +
                 "without **--enable-tls** option.\n\n"
        }
    }

    /**************************************************************************/
    /*  RETURN VALUE                                                          */
    /**************************************************************************/
    t += "# RETURN VALUE\n\n"
    if(fx.result.info) {
        t += fx.result.info + "\n\n"
    } else {
        t += "In case of success the function returns " + fx.result.success +
            ". "
        t += "In case of error it returns " + fx.result.error +
            " and sets **errno** to one of the values below.\n\n"
    }

    /**************************************************************************/
    /*  ERRORS                                                                */
    /**************************************************************************/
    t += "# ERRORS\n\n"
    if(fx.errors) {
        var errs = fx.errors.slice()
    }
    else {
        var errs = []
    }

    if(fx.has_handle_argument) errs.push("EBADF", "ENOTSUP")
    if(fx.has_deadline) errs.push("ETIMEDOUT")
    if(fx.allocates_handle) errs.push("EMFILE", "ENFILE", "ENOMEM")
    if(fx.uses_connection) errs.push("ECONNRESET", "ECANCELED")
    if(fx.mem && !mem) errs.push("ENOMEM")

    // Expand error descriptions.
    var errdict = {}
    for(var idx = 0; idx < errs.length; idx++) {
        errdict[errs[idx]] = standard_errors[errs[idx]]
    }

    // Add custom errors.
    if(fx.custom_errors) Object.assign(errdict, fx.custom_errors)

    // Print errors in alphabetic order.
    var codes = Object.keys(errdict).sort()
    if(codes.length == 0) {
        t += "None.\n"
    }
    else {
        for(var j = 0; j < codes.length; j++) {
            t += "* **" + codes[j] + "**: " + errdict[codes[j]] + "\n"
        }
    }
    t += "\n"

    /**************************************************************************/
    /*  EXAMPLE                                                               */
    /**************************************************************************/
    if(fx.example || (fx.protocol && fx.protocol.example)) {
        t += "# EXAMPLE\n\n"
        var example = fx.example
        if(example == undefined) example = fx.protocol.example
        t += "```c\n" + trimrect(example) + "\n```\n"
    }

    return t
}

for(var i = 0; i < fxs.length; i++) {
    fx = fxs[i];
    t = generate_man_page(fx, false)
    fs.writeFile(fx.name + ".md", t)
    // Mem functions have no definitions of their own. The docs are generated
    // from the related non-mem function.
    if(fx.mem != undefined) {
        t = generate_man_page(fx, true)
        fs.writeFile(fx.name + "_mem.md", t)
    }
}

