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
import platform
import stat
import sys


RENAME_NOREPLACE = 1
RENAME_EXCHANGE = 2
EXIT_UNAVAILABLE = 64
EXIT_FAILED = 65
EXIT_DESTINATION_EXISTS = 66
EXIT_RECOVERY_REQUIRED = 67


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
    except OSError:
        return None
    try:
        renameat2 = libc.renameat2
        renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        renameat2.restype = ctypes.c_int
        return renameat2
    except AttributeError:
        syscall_number = {"x86_64": 316, "aarch64": 276}.get(platform.machine())
        if syscall_number is None:
            return None
        syscall = libc.syscall
        syscall.restype = ctypes.c_long

        def raw_renameat2(old_fd, old_name, new_fd, new_name, flags):
            return syscall(syscall_number, old_fd, old_name, new_fd, new_name, flags)

        return raw_renameat2


def rename(renameat2, fd, source, destination, flags):
    result = renameat2(fd, os.fsencode(source), fd, os.fsencode(destination), flags)
    if result == 0:
        return 0
    error = ctypes.get_errno()
    if error in (errno.ENOSYS, errno.EINVAL, errno.EOPNOTSUPP):
        return EXIT_UNAVAILABLE
    if flags == RENAME_NOREPLACE and error == errno.EEXIST:
        return EXIT_DESTINATION_EXISTS
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


def valid_state_stat(file_stat, expected_uid):
    return (
        stat.S_ISREG(file_stat.st_mode)
        and stat.S_IMODE(file_stat.st_mode) == 0o600
        and file_stat.st_nlink == 1
        and file_stat.st_uid == expected_uid
    )


def parse_identity(dev_text, ino_text):
    try:
        dev = int(dev_text)
        ino = int(ino_text)
    except (TypeError, ValueError):
        return None
    return (dev, ino) if dev >= 0 and ino > 0 else None


def read_named_state(fd, name, expected_uid):
    observed = os.stat(name, dir_fd=fd, follow_symlinks=False)
    if not valid_state_stat(observed, expected_uid):
        raise OSError(errno.EPERM, "unsafe resource state identity")
    return observed


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
    status = rename(renameat2, fd, source, destination, RENAME_EXCHANGE)
    if status != 0:
        return status
    moved_first = read_probe(fd, destination)
    moved_second = read_probe(fd, source)
    if identity(moved_first) != identity(first) or identity(moved_second) != identity(second):
        return EXIT_FAILED
    os.fsync(fd)
    return 0


def commit(renameat2, fd, mode, source, destination, source_identity, destination_identity, expected_uid):
    try:
        source_before = read_named_state(fd, source, expected_uid)
    except OSError:
        return EXIT_FAILED
    if identity(source_before) != source_identity:
        return EXIT_FAILED
    if mode == "noreplace":
        try:
            os.stat(destination, dir_fd=fd, follow_symlinks=False)
            return EXIT_DESTINATION_EXISTS
        except FileNotFoundError:
            pass
        except OSError:
            return EXIT_FAILED
        flags = RENAME_NOREPLACE
    else:
        try:
            destination_before = read_named_state(fd, destination, expected_uid)
        except OSError:
            return EXIT_FAILED
        if destination_identity is None or identity(destination_before) != destination_identity:
            return EXIT_FAILED
        flags = RENAME_EXCHANGE

    status = rename(renameat2, fd, source, destination, flags)
    if status != 0:
        return status
    try:
        installed = read_named_state(fd, destination, expected_uid)
        if identity(installed) != source_identity:
            return EXIT_RECOVERY_REQUIRED
        if mode == "noreplace":
            try:
                os.stat(source, dir_fd=fd, follow_symlinks=False)
                return EXIT_RECOVERY_REQUIRED
            except FileNotFoundError:
                pass
        else:
            displaced = read_named_state(fd, source, expected_uid)
            if identity(displaced) != destination_identity:
                return EXIT_RECOVERY_REQUIRED
        os.fsync(fd)
    except OSError:
        return EXIT_RECOVERY_REQUIRED
    return 0


def main():
    if len(sys.argv) < 4:
        return EXIT_FAILED
    mode, fd_text = sys.argv[1:3]
    if not fd_text.isascii() or not fd_text.isdecimal():
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
    if mode == "available":
        return 0 if len(sys.argv) == 5 and valid_name(sys.argv[3]) and valid_name(sys.argv[4]) else EXIT_FAILED
    if mode in ("exchange", "noreplace"):
        if len(sys.argv) != 10:
            return EXIT_FAILED
        source, destination = sys.argv[3:5]
        if not valid_name(source) or not valid_name(destination):
            return EXIT_FAILED
        source_identity = parse_identity(sys.argv[5], sys.argv[6])
        destination_identity = None if mode == "noreplace" else parse_identity(sys.argv[7], sys.argv[8])
        try:
            expected_uid = int(sys.argv[9])
        except ValueError:
            return EXIT_FAILED
        if source_identity is None or expected_uid < 0 or (mode == "exchange" and destination_identity is None):
            return EXIT_FAILED
        try:
            return commit(
                renameat2,
                fd,
                mode,
                source,
                destination,
                source_identity,
                destination_identity,
                expected_uid,
            )
        except OSError as error:
            if error.errno in (errno.ENOSYS, errno.EINVAL, errno.EOPNOTSUPP):
                return EXIT_UNAVAILABLE
            return EXIT_FAILED
    if len(sys.argv) != 5 or mode != "probe":
        return EXIT_FAILED
    source, destination = sys.argv[3:]
    if not valid_name(source) or not valid_name(destination):
        return EXIT_FAILED
    try:
        return probe(renameat2, fd, source, destination)
    except OSError as error:
        if error.errno in (errno.ENOSYS, errno.EINVAL, errno.EOPNOTSUPP):
            return EXIT_UNAVAILABLE
        return EXIT_FAILED


if __name__ == "__main__":
    sys.exit(main())
