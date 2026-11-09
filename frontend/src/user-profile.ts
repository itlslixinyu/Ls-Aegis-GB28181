import type { User, UserProfileFields } from "./api";
export function profileFields(
  user?: Partial<UserProfileFields> | null,
): UserProfileFields {
  return {
    displayName: user?.displayName || "",
    department: user?.department || "",
    jobTitle: user?.jobTitle || "",
    phone: user?.phone || "",
    email: user?.email || "",
    remark: user?.remark || "",
  };
}
export const profileDate = (value?: string | null) =>
  value ? new Date(value).toLocaleString() : "暂无记录";
export function syncOwnProfile(user: User, current: { value: User | null }) {
  if (current.value?.id === user.id)
    current.value = { ...current.value, ...user };
}
