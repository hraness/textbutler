/* TextButler's persistent macOS parent. The generated configuration closes
 * every launch path and argument; this is not a general-purpose Bun launcher. */
#include "textbutler-launch-config.h"

#include <CommonCrypto/CommonDigest.h>
#include <CoreFoundation/CoreFoundation.h>
#include <ApplicationServices/ApplicationServices.h>
#include <mach-o/dyld.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define TB_GRACE_SECONDS 50
#define TB_RUNTIME_LIMIT (128LL * 1024 * 1024)
#define TB_ENTRYPOINT_LIMIT (64LL * 1024 * 1024)

typedef struct {
  const char *path;
  int fd;
  struct stat identity;
} CheckedFile;

static volatile sig_atomic_t pending_signal;
static sigset_t forwarded_signals;

static int failure(const char *code) {
  fprintf(stderr, "TextButler could not start or supervise its configured service (%s).\n", code);
  return 1;
}

static bool owner(uid_t uid) { return uid == 0 || uid == (uid_t)TB_UID; }

static bool absolute_path(const char *path) {
  size_t length = strnlen(path, PATH_MAX);
  if (length < 2 || length == PATH_MAX || path[0] != '/' || path[length - 1] == '/') return false;
  for (size_t i = 0; i < length; i++) {
    unsigned char c = (unsigned char)path[i];
    if (c < 0x20 || c == 0x7f) return false;
    if (path[i] == '/' && (path[i + 1] == '/' ||
        (path[i + 1] == '.' && (path[i + 2] == '/' || path[i + 2] == '\0' ||
          (path[i + 2] == '.' && (path[i + 3] == '/' || path[i + 3] == '\0')))))) return false;
  }
  return true;
}

static bool physical(const char *path) {
  char resolved[PATH_MAX];
  return absolute_path(path) && realpath(path, resolved) != NULL && strcmp(path, resolved) == 0;
}

/* Every ancestor must be physical and protected against other users' writes.
 * Root-owned ancestors are normal; product directories belong to this owner. */
static bool directory(const char *path, bool exact_owner) {
  char part[PATH_MAX];
  struct stat info;
  if (!physical(path)) return false;
  memcpy(part, path, strlen(path) + 1);
  for (char *cursor = part + 1;; cursor++) {
    if (*cursor != '/' && *cursor != '\0') continue;
    char saved = *cursor;
    *cursor = '\0';
    if (lstat(part, &info) != 0 || !S_ISDIR(info.st_mode) || !owner(info.st_uid) || (info.st_mode & 0022) != 0) return false;
    *cursor = saved;
    if (saved == '\0') break;
  }
  return !exact_owner || info.st_uid == (uid_t)TB_UID;
}

static bool parent_directory(const char *path, bool exact_owner) {
  char parent[PATH_MAX];
  if (!absolute_path(path)) return false;
  memcpy(parent, path, strlen(path) + 1);
  char *slash = strrchr(parent, '/');
  if (slash == parent) return false;
  *slash = '\0';
  return directory(parent, exact_owner);
}

static bool same_identity(const struct stat *a, const struct stat *b) {
  return a->st_dev == b->st_dev && a->st_ino == b->st_ino && a->st_mode == b->st_mode &&
    a->st_uid == b->st_uid && a->st_gid == b->st_gid && a->st_nlink == b->st_nlink &&
    a->st_size == b->st_size && a->st_mtimespec.tv_sec == b->st_mtimespec.tv_sec &&
    a->st_mtimespec.tv_nsec == b->st_mtimespec.tv_nsec && a->st_ctimespec.tv_sec == b->st_ctimespec.tv_sec &&
    a->st_ctimespec.tv_nsec == b->st_ctimespec.tv_nsec;
}

static bool unchanged(const CheckedFile *file) {
  struct stat current, named;
  return fstat(file->fd, &current) == 0 && lstat(file->path, &named) == 0 &&
    same_identity(&file->identity, &current) && same_identity(&current, &named);
}

static bool expected_digest(const char *digest) {
  if (strnlen(digest, CC_SHA256_DIGEST_LENGTH * 2 + 1) != CC_SHA256_DIGEST_LENGTH * 2) return false;
  for (size_t i = 0; i < CC_SHA256_DIGEST_LENGTH * 2; i++)
    if (!((digest[i] >= '0' && digest[i] <= '9') || (digest[i] >= 'a' && digest[i] <= 'f'))) return false;
  return true;
}

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
static bool check_file(CheckedFile *file, const char *path, const char *digest, off_t limit, bool executable) {
  unsigned char block[65536], result[CC_SHA256_DIGEST_LENGTH];
  char hex[CC_SHA256_DIGEST_LENGTH * 2 + 1];
  CC_SHA256_CTX hash;
  file->path = path;
  file->fd = -1;
  if (!expected_digest(digest) || !physical(path) || !parent_directory(path, false)) return false;
  file->fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (file->fd >= 0 && file->fd < 3) {
    int reserved = fcntl(file->fd, F_DUPFD_CLOEXEC, 3);
    close(file->fd);
    file->fd = reserved;
  }
  if (file->fd < 0 || fstat(file->fd, &file->identity) != 0) return false;
  const struct stat *info = &file->identity;
  if (!S_ISREG(info->st_mode) || !owner(info->st_uid) || (info->st_mode & 0022) != 0 ||
      (info->st_mode & (S_ISUID | S_ISGID)) != 0 || info->st_size < 1 || info->st_size > limit ||
      (executable && (info->st_mode & 0111) == 0) || !unchanged(file) || CC_SHA256_Init(&hash) != 1) return false;
  off_t total = 0;
  for (;;) {
    ssize_t count = read(file->fd, block, sizeof(block));
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) return false;
    if (count == 0) break;
    total += count;
    if (total > info->st_size || CC_SHA256_Update(&hash, block, (CC_LONG)count) != 1) return false;
  }
  if (total != info->st_size || !unchanged(file) || CC_SHA256_Final(result, &hash) != 1) return false;
  static const char digits[] = "0123456789abcdef";
  for (size_t i = 0; i < sizeof(result); i++) {
    hex[i * 2] = digits[result[i] >> 4];
    hex[i * 2 + 1] = digits[result[i] & 15];
  }
  hex[sizeof(hex) - 1] = '\0';
  return strcmp(hex, digest) == 0;
}
#pragma clang diagnostic pop

static bool app_identity(void) {
  char running[PATH_MAX], resolved[PATH_MAX], main_bundle[PATH_MAX], macos_directory[PATH_MAX], plist[PATH_MAX];
  uint32_t capacity = sizeof(running);
  struct stat executable, info;
  if (!directory(TB_APP_PATH, true) || !physical(TB_EXECUTABLE_PATH) ||
      !parent_directory(TB_EXECUTABLE_PATH, true) ||
      _NSGetExecutablePath(running, &capacity) != 0 || realpath(running, resolved) == NULL ||
      strcmp(resolved, TB_EXECUTABLE_PATH) != 0 || lstat(TB_EXECUTABLE_PATH, &executable) != 0 ||
      !S_ISREG(executable.st_mode) || executable.st_uid != (uid_t)TB_UID ||
      (executable.st_mode & (0022 | S_ISUID | S_ISGID)) != 0 || (executable.st_mode & 0100) == 0) return false;
  int written = snprintf(macos_directory, sizeof(macos_directory), "%s/Contents/MacOS/", TB_APP_PATH);
  if (written < 1 || (size_t)written >= sizeof(macos_directory) ||
      strncmp(TB_EXECUTABLE_PATH, macos_directory, (size_t)written) != 0 ||
      TB_EXECUTABLE_PATH[written] == '\0' || strchr(&TB_EXECUTABLE_PATH[written], '/') != NULL) return false;
  written = snprintf(plist, sizeof(plist), "%s/Contents/Info.plist", TB_APP_PATH);
  if (written < 1 || (size_t)written >= sizeof(plist) || !physical(plist) || lstat(plist, &info) != 0 ||
      !S_ISREG(info.st_mode) || info.st_uid != (uid_t)TB_UID || (info.st_mode & 0022) != 0 ||
      info.st_size < 1 || info.st_size > 65536) return false;
  CFBundleRef bundle = CFBundleGetMainBundle();
  if (bundle == NULL) return false;
  CFStringRef configured = CFStringCreateWithCString(kCFAllocatorDefault, TB_BUNDLE_ID, kCFStringEncodingUTF8);
  CFStringRef identifier = CFBundleGetIdentifier(bundle);
  CFTypeRef package_type = CFBundleGetValueForInfoDictionaryKey(bundle, CFSTR("CFBundlePackageType"));
  CFURLRef url = CFBundleCopyBundleURL(bundle);
  bool valid = configured != NULL && identifier != NULL && url != NULL && package_type != NULL &&
    CFEqual(package_type, CFSTR("APPL")) && CFEqual(identifier, configured) &&
    CFURLGetFileSystemRepresentation(url, true, (UInt8 *)main_bundle, sizeof(main_bundle)) &&
    strcmp(main_bundle, TB_APP_PATH) == 0;
  if (url != NULL) CFRelease(url);
  if (configured != NULL) CFRelease(configured);
  return valid;
}

static bool generation(const char *value) {
  if (strnlen(value, 37) != 36) return false;
  for (size_t i = 0; i < 36; i++) {
    if (i == 8 || i == 13 || i == 18 || i == 23) { if (value[i] != '-') return false; }
    else if (!((value[i] >= '0' && value[i] <= '9') || (value[i] >= 'a' && value[i] <= 'f'))) return false;
  }
  return true;
}

static void receive_signal(int signal_number) { pending_signal = signal_number; }

static bool prepare_signals(void) {
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = SIG_DFL;
  sigemptyset(&action.sa_mask);
  /* A launching shell may ignore SIGCHLD. Restore waitable child ownership. */
  if (sigaction(SIGCHLD, &action, NULL) != 0) return false;
  sigemptyset(&forwarded_signals);
  sigaddset(&forwarded_signals, SIGTERM);
  sigaddset(&forwarded_signals, SIGINT);
  sigaddset(&forwarded_signals, SIGHUP);
  action.sa_handler = receive_signal;
  action.sa_mask = forwarded_signals;
  return sigprocmask(SIG_BLOCK, &forwarded_signals, NULL) == 0 &&
    sigaction(SIGTERM, &action, NULL) == 0 && sigaction(SIGINT, &action, NULL) == 0 &&
    sigaction(SIGHUP, &action, NULL) == 0;
}

static int take_signal(void) {
  sigset_t previous;
  if (sigprocmask(SIG_BLOCK, &forwarded_signals, &previous) != 0) return -1;
  int signal_number = pending_signal;
  pending_signal = 0;
  if (sigprocmask(SIG_SETMASK, &previous, NULL) != 0) return -1;
  return signal_number;
}

static bool monotonic(struct timespec *now) { return clock_gettime(CLOCK_MONOTONIC, now) == 0; }

static int supervise(pid_t child) {
  struct timespec deadline = {0, 0};
  bool stopping = false, forced = false;
  if (sigprocmask(SIG_UNBLOCK, &forwarded_signals, NULL) != 0) {
    kill(child, SIGKILL);
    forced = true;
  }
  for (;;) {
    int status = 0;
    pid_t result = waitpid(child, &status, WNOHANG);
    if (result == child) {
      if (forced) return failure("child-forced-stop");
      if (WIFEXITED(status)) return WEXITSTATUS(status);
      if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
      return failure("child-exit-unconfirmed");
    }
    if (result < 0 && errno != EINTR) return failure("child-wait-failed");
    int requested = take_signal();
    if (requested < 0) {
      kill(child, SIGKILL);
      forced = true;
    } else if (requested != 0 && !forced) {
      /* Only the forked child is ours to signal. In particular, do not sweep
       * process groups or terminate detached provider-owned processes. */
      if (kill(child, requested) != 0 && errno != ESRCH) {
        kill(child, SIGKILL);
        forced = true;
      }
      if (!stopping) {
        stopping = true;
        if (!monotonic(&deadline)) { kill(child, SIGKILL); forced = true; }
        else deadline.tv_sec += TB_GRACE_SECONDS;
      }
    }
    if (stopping && !forced) {
      struct timespec now;
      if (!monotonic(&now) || now.tv_sec > deadline.tv_sec ||
          (now.tv_sec == deadline.tv_sec && now.tv_nsec >= deadline.tv_nsec)) {
        kill(child, SIGKILL);
        forced = true;
      }
    }
    struct timespec interval = {0, 100000000};
    nanosleep(&interval, NULL);
  }
}

/* This consent API sends no Apple Event. It runs only for explicit setup, in a
 * bounded child so a stalled system prompt cannot hold the supervisor forever.
 * Apple documents the caller may block while the owner responds to the prompt. */
static int request_automation_permission(void) {
  const char *identifier = TB_MESSAGES_BUNDLE_ID;
  AEAddressDesc target = {typeNull, NULL};
  OSStatus status = AECreateDesc(typeApplicationBundleID, identifier, (Size)strlen(identifier), &target);
  if (status == noErr) {
    status = AEDeterminePermissionToAutomateTarget(&target, typeWildCard, typeWildCard, true);
    AEDisposeDesc(&target);
  }
  return status == noErr ? 0 : status == errAEEventNotPermitted ? 2 : 3;
}

static const char *automation_permission(void) {
#ifdef TB_TEST_AUTOMATION_PERMISSION
  return TB_TEST_AUTOMATION_PERMISSION;
#else
  pid_t child = fork();
  if (child < 0) return "unavailable";
  if (child == 0) {
    struct sigaction action;
    memset(&action, 0, sizeof(action)); action.sa_handler = SIG_DFL; sigemptyset(&action.sa_mask);
    sigset_t empty; sigemptyset(&empty);
    if (sigaction(SIGTERM, &action, NULL) != 0 || sigaction(SIGINT, &action, NULL) != 0 ||
        sigaction(SIGHUP, &action, NULL) != 0 || sigprocmask(SIG_SETMASK, &empty, NULL) != 0) _exit(3);
    /* CoreFoundation already initialized in the parent. Never invoke Apple
     * framework APIs after fork: exec a fresh copy with this one fixed role. */
    char *arguments[] = {TB_EXECUTABLE_PATH, "--request-imessage-automation", NULL};
    char home[PATH_MAX + 6]; snprintf(home, sizeof(home), "HOME=%s", TB_HOME);
    char *environment[] = {home, "PATH=/usr/bin:/bin:/usr/sbin:/sbin", NULL};
    execve(TB_EXECUTABLE_PATH, arguments, environment);
    _exit(3);
  }
  struct timespec deadline;
  bool forced = !monotonic(&deadline);
  if (!forced) deadline.tv_sec += 120;
  if (sigprocmask(SIG_UNBLOCK, &forwarded_signals, NULL) != 0) forced = true;
  if (forced) kill(child, SIGKILL);
  for (;;) {
    int status = 0;
    pid_t result = waitpid(child, &status, WNOHANG);
    if (result == child) {
      if (sigprocmask(SIG_BLOCK, &forwarded_signals, NULL) != 0) return "unavailable";
      if (forced || !WIFEXITED(status)) return "unavailable";
      return WEXITSTATUS(status) == 0 ? "allowed" : WEXITSTATUS(status) == 2 ? "denied" : "unavailable";
    }
    if (result < 0 && errno != EINTR) return "unavailable";
    struct timespec now;
    if (!forced && (take_signal() != 0 || !monotonic(&now) || now.tv_sec > deadline.tv_sec ||
        (now.tv_sec == deadline.tv_sec && now.tv_nsec >= deadline.tv_nsec))) { kill(child, SIGKILL); forced = true; }
    struct timespec pause = {0, 20000000}; nanosleep(&pause, NULL);
  }
#endif
}

int main(int argc, char **argv) {
  enum { MENU, DAEMON, IMESSAGE_SETUP, AUTOMATION_PERMISSION } role;
  if (argc == 1) role = MENU;
  else if (argc == 2 && strcmp(argv[1], "--daemon") == 0) role = DAEMON;
  else if (argc == 2 && strcmp(argv[1], "--imessage-setup") == 0) role = IMESSAGE_SETUP;
  else if (argc == 2 && strcmp(argv[1], "--request-imessage-automation") == 0) role = AUTOMATION_PERMISSION;
  else return failure("unsupported-role");
  if ((uid_t)TB_UID == 0 || getuid() != (uid_t)TB_UID || geteuid() != (uid_t)TB_UID ||
      getgid() != getegid()) return failure("owner-mismatch");
  if (!app_identity() || !directory(TB_HOME, true) || !absolute_path(TB_DATA_DIR)) return failure("app-identity");
  if (role == AUTOMATION_PERMISSION) return request_automation_permission();
  struct stat data;
  if (lstat(TB_DATA_DIR, &data) == 0) {
    if (!directory(TB_DATA_DIR, true)) return failure("data-directory");
  } else if (errno != ENOENT || !parent_directory(TB_DATA_DIR, true)) return failure("data-directory");

  CheckedFile runtime = {.fd = -1}, entrypoint = {.fd = -1};
  bool valid = check_file(&runtime, TB_RUNTIME, TB_RUNTIME_SHA256, TB_RUNTIME_LIMIT, true) &&
    check_file(&entrypoint, TB_ENTRYPOINT, TB_ENTRYPOINT_SHA256, TB_ENTRYPOINT_LIMIT, false);
  if (!valid) {
    if (runtime.fd >= 0) close(runtime.fd);
    if (entrypoint.fd >= 0) close(entrypoint.fd);
    return failure("configured-artifact");
  }
  umask(0077);
  if (chdir("/") != 0 || !prepare_signals()) { close(runtime.fd); close(entrypoint.fd); return failure("launch-precondition"); }
  char home_env[PATH_MAX + 6], generation_env[80], automation_env[64];
  snprintf(home_env, sizeof(home_env), "HOME=%s", TB_HOME);
  char *environment[] = {home_env, "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "BUN_RUNTIME_TRANSPILER_CACHE_PATH=0", NULL, NULL, NULL};
  size_t environment_count = 3;
  const char *launch_generation = getenv("TEXTBUTLER_LAUNCH_AGENT_GENERATION");
  if (launch_generation != NULL) {
    if (!generation(launch_generation)) { close(runtime.fd); close(entrypoint.fd); return failure("launch-generation"); }
    if (role == DAEMON || role == IMESSAGE_SETUP) {
      snprintf(generation_env, sizeof(generation_env), "TEXTBUTLER_LAUNCH_AGENT_GENERATION=%s", launch_generation);
      environment[environment_count++] = generation_env;
    }
  }
  if (role == IMESSAGE_SETUP) {
    snprintf(automation_env, sizeof(automation_env), "TEXTBUTLER_IMESSAGE_AUTOMATION=%s", automation_permission());
    environment[environment_count++] = automation_env;
  }
  char *child_argv[] = {TB_RUNTIME, "--config=/dev/null", "--cwd=/", "--no-env-file", TB_ENTRYPOINT,
    role == MENU ? "menubar" : role == DAEMON ? "daemon" : "app",
    role == MENU ? "--foreground" : role == DAEMON ? "run" : "imessage-setup",
    "--data-dir", TB_DATA_DIR, NULL};
  if (!unchanged(&runtime) || !unchanged(&entrypoint)) {
    close(runtime.fd); close(entrypoint.fd); return failure("launch-precondition");
  }
  pid_t child = fork();
  if (child < 0) { close(runtime.fd); close(entrypoint.fd); return failure("fork"); }
  if (child == 0) {
    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_handler = SIG_DFL;
    sigemptyset(&action.sa_mask);
    sigset_t empty;
    sigemptyset(&empty);
    int input = open("/dev/null", O_RDONLY | O_CLOEXEC);
    if (input < 0 || (input != STDIN_FILENO && dup2(input, STDIN_FILENO) < 0) ||
        (input == STDIN_FILENO && fcntl(input, F_SETFD, 0) < 0) || setpgid(0, 0) != 0 ||
        !unchanged(&runtime) || !unchanged(&entrypoint) || sigaction(SIGTERM, &action, NULL) != 0 ||
        sigaction(SIGINT, &action, NULL) != 0 || sigaction(SIGHUP, &action, NULL) != 0 ||
        sigprocmask(SIG_SETMASK, &empty, NULL) != 0) _exit(126);
    if (input != STDIN_FILENO) close(input);
    close(runtime.fd);
    close(entrypoint.fd);
    execve(TB_RUNTIME, child_argv, environment);
    _exit(126);
  }
  close(runtime.fd);
  close(entrypoint.fd);
  return supervise(child);
}
