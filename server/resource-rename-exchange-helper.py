#!/usr/bin/env python3
"""Minimal renameat2(RENAME_EXCHANGE) helper for one inherited directory fd.

The probe deliberately leaves its two private files in place. Linux has no
inode-conditional unlink primitive, so deleting a path after an identity check
would reintroduce the pathname substitution race this helper exists to avoid.
The Node owner reports both exact basenames for explicit recovery.
"""

import ctypes
import errno
import os
import stat
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


def load_renameat2():
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        renameat2 = libc.renameat2
    except (OSError, AttributeError):
        return None
    renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    renameat2.restype = ctypes.c_int
    return renameat2


def exchange(renameat2, fd, source, destination):
    result = renameat2(fd, os.fsencode(source), fd, os.fsencode(destination), RENAME_EXCHANGE)
    if result == 0:
        return 0
    error = ctypes.get_errno()
    if error in (errno.ENOSYS, errno.EINVAL, errno.EOPNOTSUPP):
        return EXIT_UNAVAILABLE
    return EXIT_FAILED


def identity(file_stat):
    return (file_stat.st_dev, file_stat.st_ino)


def valid_probe_stat(file_stat):
    return (
        stat.S_ISREG(file_stat.st_mode)
        and stat.S_IMODE(file_stat.st_mode) == 0o600
        and file_stat.st_nlink == 1
        and file_stat.st_uid == os.getuid()
        and file_stat.st_size == 0
    )


def create_probe(fd, name):
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    flags |= getattr(os, "O_NOFOLLOW", 0)
    flags |= getattr(os, "O_CLOEXEC", 0)
    probe_fd = os.open(name, flags, 0o600, dir_fd=fd)
    try:
        os.fchmod(probe_fd, 0o600)
        os.fsync(probe_fd)
        created = os.fstat(probe_fd)
        if not valid_probe_stat(created):
            raise OSError(errno.EPERM, "unsafe probe identity")
        return created
    finally:
        os.close(probe_fd)


def read_probe(fd, name):
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
    opened_fd = os.open(name, flags, dir_fd=fd)
    try:
        observed = os.fstat(opened_fd)
        if not valid_probe_stat(observed):
            raise OSError(errno.EPERM, "unsafe exchanged probe identity")
        return observed
    finally:
        os.close(opened_fd)


def probe(renameat2, fd, source, destination):
    # There is intentionally no cleanup here. Even after a successful fstat,
    # unlinking by name could remove a substituted inode. The exact random
    # basenames are returned by the Node owner for operator recovery instead.
    first = create_probe(fd, source)
    second = create_probe(fd, destination)
    os.fsync(fd)
    status = exchange(renameat2, fd, source, destination)
    if status != 0:
        return status
    moved_first = read_probe(fd, destination)
    moved_second = read_probe(fd, source)
    if identity(moved_first) != identity(first) or identity(moved_second) != identity(second):
        return EXIT_FAILED
    os.fsync(fd)
    return 0


def main():
    if len(sys.argv) != 5 or sys.argv[1] not in ("probe", "exchange"):
        return EXIT_FAILED
    mode, fd_text, source, destination = sys.argv[1:]
    if not fd_text.isascii() or not fd_text.isdecimal() or not valid_name(source) or not valid_name(destination):
        return EXIT_FAILED
    fd = int(fd_text)
    try:
        directory = os.fstat(fd)
    except OSError:
        return EXIT_FAILED
    if not stat.S_ISDIR(directory.st_mode):
        return EXIT_FAILED
    if not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_CLOEXEC"):
        return EXIT_UNAVAILABLE
    renameat2 = load_renameat2()
    if renameat2 is None:
        return EXIT_UNAVAILABLE
    try:
        return probe(renameat2, fd, source, destination) if mode == "probe" else exchange(renameat2, fd, source, destination)
    except OSError as error:
        if error.errno in (errno.ENOSYS, errno.EINVAL, errno.EOPNOTSUPP):
            return EXIT_UNAVAILABLE
        return EXIT_FAILED


if __name__ == "__main__":
    sys.exit(main())
