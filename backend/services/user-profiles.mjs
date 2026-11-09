import { authorization } from "./authorization.mjs";
const fields = {
  displayName: ["姓名", 50],
  department: ["所属部门", 80],
  jobTitle: ["职务", 50],
  phone: ["联系电话", 32],
  email: ["电子邮箱", 254],
  remark: ["备注", 500],
};
function invalid(message, status = 400, code = "INVALID_PROFILE") {
  return Object.assign(Error(message), { status, code });
}
export const userColumns = `u.id,u.username,u.role,p.displayName,p.department,p.jobTitle,p.phone,p.email,p.remark,p.createdAt,p.lastLoginAt,p.updatedAt,p.version`;
export function publicUser(db, id) {
  const user = db
    .prepare(
      `SELECT ${userColumns} FROM users u JOIN user_profiles p ON p.userId=u.id WHERE u.id=?`,
    )
    .get(id);
  return user ? { ...user, ...authorization(db, id) } : undefined;
}
export function validateProfile(value = {}, requireVersion = false) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid("用户资料须为对象");
  const allowed = new Set([
    ...Object.keys(fields),
    ...(requireVersion ? ["version"] : []),
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key)))
    throw invalid("用户资料包含不允许修改的字段");
  if (
    requireVersion &&
    (!Number.isSafeInteger(value.version) || value.version < 0)
  )
    throw invalid("请先读取当前用户资料后再保存");
  const result = {};
  for (const [key, [label, max]] of Object.entries(fields)) {
    const input = value[key] ?? "";
    if (typeof input !== "string") throw invalid(`${label}须为文本`);
    const text = input.trim();
    if (text.length > max) throw invalid(`${label}不能超过 ${max} 个字符`);
    if (
      (key === "remark"
        ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
        : /[\u0000-\u001f\u007f]/
      ).test(text)
    )
      throw invalid(`${label}包含不支持的控制字符`);
    result[key] = text;
  }
  if (
    result.phone &&
    (!/^\+?[0-9 ()-]+$/.test(result.phone) ||
      (result.phone.match(/\d/g) || []).length < 3)
  )
    throw invalid(
      "联系电话格式不正确，可填写数字、国家区号、空格、括号或短横线",
    );
  if (result.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email))
    throw invalid("电子邮箱格式不正确");
  return result;
}
export function saveProfile(db, id, value) {
  const profile = validateProfile(value, true);
  if (!publicUser(db, id)) throw invalid("用户不存在", 404, "USER_NOT_FOUND");
  const saved = db
    .prepare(
      `UPDATE user_profiles SET displayName=?,department=?,jobTitle=?,phone=?,email=?,remark=?,updatedAt=?,version=version+1 WHERE userId=? AND version=?`,
    )
    .run(
      ...Object.keys(fields).map((key) => profile[key]),
      new Date().toISOString(),
      id,
      value.version,
    );
  if (!saved.changes)
    throw invalid(
      "资料已由其他页面更新，请重新读取后再保存",
      409,
      "PROFILE_CONFLICT",
    );
  return publicUser(db, id);
}
export function initializeProfile(db, id, value) {
  const profile = validateProfile(value);
  db.prepare(
    `UPDATE user_profiles SET displayName=?,department=?,jobTitle=?,phone=?,email=?,remark=? WHERE userId=?`,
  ).run(...Object.keys(fields).map((key) => profile[key]), id);
}
