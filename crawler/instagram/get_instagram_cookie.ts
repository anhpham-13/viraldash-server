import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

const COOKIE_PATH = path.join(process.cwd(), 'data', 'instagram', 'cookie.json');

async function generateCookie() {
    // Đảm bảo thư mục tồn tại
    fs.mkdirSync(path.dirname(COOKIE_PATH), { recursive: true });

    console.log('--- [PLAYWRIGHT] Đang khởi động trình duyệt... ---');
    const browser = await chromium.launch({
        headless: false // Bắt buộc bằng false để hiển thị màn hình cho bạn thao tác
    });

    const context = await browser.newContext();
    const page = await context.newPage();

    // Đi tới trang đăng nhập Instagram
    await page.goto('https://www.instagram.com/accounts/login/');

    console.log('\n👉 HƯỚNG DẪN: Bạn hãy tiến hành đăng nhập trên màn hình trình duyệt vừa hiện lên (bằng tài khoản/mật khẩu hoặc qua Facebook đều được).');
    console.log('👉 Sau khi đăng nhập thành công vào hẳn Trang chủ Instagram, hãy quay lại Terminal này và nhấn [ENTER] để lưu Cookie.\n');

    // Chờ người dùng nhấn Enter ở Terminal để hoàn tất
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await new Promise<void>((resolve) => {
        rl.question('Nhấn [ENTER] tại đây sau khi đã đăng nhập thành công trên trình duyệt...', () => {
            rl.close();
            resolve();
        });
    });

    // Lấy toàn bộ cookies hiện tại từ phiên đăng nhập hợp lệ
    const cookies = await context.cookies();

    // Lưu cookies xuống file JSON dưới dạng chuỗi sạch
    fs.writeFileSync(COOKIE_PATH, JSON.stringify(cookies, null, 2), 'utf8');
    console.log(`\n✅ [THÀNH CÔNG] Đã lưu Cookies vào file: ${COOKIE_PATH}`);

    await browser.close();
}

generateCookie();