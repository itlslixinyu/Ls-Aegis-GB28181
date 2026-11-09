import { ref } from "vue";
export interface UserProfileFields {
  displayName: string;
  department: string;
  jobTitle: string;
  phone: string;
  email: string;
  remark: string;
}
export interface User extends Partial<UserProfileFields> {
  id: string;
  username: string;
  role: "admin" | "viewer";
  createdAt?: string | null;
  lastLoginAt?: string | null;
  updatedAt?: string | null;
  version?: number;
  roleId?: string;
  roleName?: string;
  permissions?: string[];
  scopeMode?: "all" | "groups";
  authorizationVersion?: number;
}
export interface Device {
  groupId: string;
  groupName: string;
  id: string;
  deviceId: string;
  name: string;
  status: string;
  channels: number;
  createdAt: string;
  sipTransport?: string;
  mediaTransport?: string;
}
export const currentUser = ref<User | null>(null);
const legacyViewerPermissions = [
  "devices.view",
  "live.preview",
  "recording.view",
  "recording.download",
  "alarms.view",
  "map.view",
  "tracks.view",
  "subscriptions.view",
];
export function can(permission: string, user: User | null = currentUser.value) {
  return (
    !!user &&
    (user.role === "admin" ||
      (user.permissions ?? legacyViewerPermissions).includes(permission))
  );
}
export const roleLabel = (user: User | null | undefined) =>
  user?.roleName || (user?.role === "admin" ? "系统管理员" : "只读用户");
let refreshing: Promise<void> | null = null;
export function refreshCurrentUser() {
  if (!currentUser.value) return Promise.resolve();
  if (!refreshing)
    refreshing = api<{ user: User; csrf: string }>("/me")
      .then((value) => {
        if (currentUser.value?.id === value.user.id) {
          currentUser.value = value.user;
          csrf = value.csrf;
        }
      })
      .finally(() => {
        refreshing = null;
      });
  return refreshing;
}
export const authNotice = ref("");
let csrf = "";
let sessionGeneration = 0;
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code = "") {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}
function clearSession(notice = "") {
  sessionGeneration++;
  currentUser.value = null;
  csrf = "";
  authNotice.value = notice;
}
export async function api<T>(
  path: string,
  method = "GET",
  data?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const generation = sessionGeneration,
    controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch("/api/v1" + path, {
      method,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf,
        ...headers,
      },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    });
    if (generation !== sessionGeneration)
      throw Error("登录状态已变化，请刷新后重试");
    if (response.status === 204) return undefined as T;
    let result;
    try {
      result = await response.json();
    } catch {
      if (generation !== sessionGeneration)
        throw Error("登录状态已变化，请刷新后重试");
      if (controller.signal.aborted)
        throw Error("请求超时，请刷新确认操作结果后重试");
      if (response.status === 401 && path !== "/auth/login")
        clearSession(currentUser.value ? "登录已过期，请重新登录" : "");
      throw new ApiError(
        response.status === 401
          ? "登录已过期，请重新登录"
          : "服务响应格式异常，请刷新后重试",
        response.status,
      );
    }
    if (generation !== sessionGeneration)
      throw Error("登录状态已变化，请刷新后重试");
    if (!response.ok) {
      if (
        response.status === 403 &&
        ["FORBIDDEN", "PERMISSION_DENIED"].includes(result?.error?.code) &&
        path !== "/me"
      )
        void refreshCurrentUser().catch(() => {});
      if (response.status === 401 && path !== "/auth/login")
        clearSession(currentUser.value ? "登录已过期，请重新登录" : "");
      else if (
        response.status === 403 &&
        result?.error?.code === "CSRF_REJECTED"
      )
        clearSession("会话校验失败，请重新登录");
      throw new ApiError(
        typeof result?.error?.message === "string"
          ? result.error.message
          : "请求失败（HTTP " + response.status + "）",
        response.status,
        typeof result?.error?.code === "string" ? result.error.code : "",
      );
    }
    if (
      !result ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      !("data" in result)
    )
      throw Error("服务响应格式异常，请刷新后重试");
    return result.data as T;
  } catch (e) {
    if (controller.signal.aborted)
      throw Error("请求超时，请刷新确认操作结果后重试");
    if (e instanceof TypeError)
      throw Error(
        "网络连接失败，请检查网络或服务状态，并刷新确认操作结果后重试",
      );
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
export function setSession(value: { user: User; csrf: string }) {
  sessionGeneration++;
  currentUser.value = value.user;
  csrf = value.csrf;
  authNotice.value = "";
}
export async function logout() {
  await api("/auth/logout", "POST");
  clearSession();
}
export async function changeOwnPassword(
  currentPassword: string,
  newPassword: string,
) {
  await api("/me/password", "POST", { currentPassword, newPassword });
  clearSession("密码已更新，请用新密码登录");
}
export const messageOf = (e: unknown) =>
  e instanceof Error ? e.message : "请求失败";

export interface RecordClip {
  id: string;
  channelId: string;
  name: string;
  start: string;
  end: string;
  type: string;
  filePath: string;
}
