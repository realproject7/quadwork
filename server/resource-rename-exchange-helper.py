#!/usr/bin/env python3
"""Minimal renameat2(RENAME_EXCHANGE) helper for one inherited directory fd."""

import ctypes
import errno
import os
import sys


RENAME_EXCHANGE = 2
EXIT_UNAVAILABLE = 64
EXIT_FAILED = 65


def valid_name(value):
    return (
        value
        and value not in (".", "..")
        and "/" not in value
        and "\\" not in value
        and "\x00" not in value
        and os.path.basename(value) == value
    )


def main():
    if len(sys.argv) != 5 or sys.argv[1] not in ("probe", "exchange"):
        return EXIT_FAILED
    mode, fd_text, source, destination = sys.argv[1:]
    if not fd_text.isascii() or not fd_text.isdecimal() or not valid_name(source) or not valid_name(destination):
        return EXIT_FAILED
    fd = int(fd_text)
    try:
        os.fstat(fd)
        libc = ctypes.CDLL(None, use_errno=True)
        renameat2 = libc.renameat2
    except (OSError, AttributeError):
        return EXIT_UNAVAILABLE
    renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    renameat2.restype = ctypes.c_int
    result = renameat2(fd, os.fsencode(source), fd, os.fsencode(destination), RENAME_EXCHANGE)
    if result == 0:
        return 0
    error = ctypes.get_errno()
    if mode == "probe" and error == errno.ENOENT:
        return 0
    if error in (errno.ENOSYS, errno.EINVAL, errno.EOPNOTSUPP):
        return EXIT_UNAVAILABLE
    return EXIT_FAILED


if __name__ == "__main__":
    sys.exit(main())
