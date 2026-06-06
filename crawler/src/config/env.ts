// Re-export từ shared — backward compat cho toàn bộ crawler files hiện tại.
// Không thêm logic mới tại đây. Import trực tiếp từ @shared/config nếu cần thêm field.
export { env, loadEnv } from "../../../shared/config/env.js";
export type { AppEnv }  from "../../../shared/config/env.js";
