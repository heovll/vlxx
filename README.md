# VLXX Render Free

Gói này chuyển addon VLXX từ Windows Service sang Render Web Service. Ứng dụng vẫn dùng Node.js/Express, nguồn mặc định là `https://vlxx.phd`, và proxy media được giữ nguyên.

## Tệp cần deploy

Đưa các tệp sau lên một repository GitHub riêng hoặc upload vào project Render:

- `server.js`
- `vlxx-ms.js`
- `media-proxy.js`
- `package.json`
- `package-lock.json`
- `render.yaml`

Không cần đưa `nssm.exe`, các script PowerShell, `node_modules` hoặc thư mục `logs`.

## Cấu hình Render

Tạo một Render **Web Service** với:

- Build Command: `npm ci`
- Start Command: `npm start`
- Health Check Path: `/health`
- Plan: Free để thử nghiệm

Thêm biến môi trường:

```text
VLXX_BASE_URL=https://vlxx.phd
HOST=0.0.0.0
NODE_ENV=production
```

Render tự cung cấp biến `PORT`; `server.js` dùng biến này và vẫn dùng port `10004` làm fallback khi chạy local Windows.

Sau khi Render cấp URL, ví dụ `https://vlxx-phd-addon.onrender.com`, có thể đặt thêm:

```text
PUBLIC_URL=https://vlxx-phd-addon.onrender.com
```

Nếu không đặt `PUBLIC_URL`, code sẽ thử dùng `RENDER_EXTERNAL_URL` và sau cùng mới fallback về localhost.

## Link cài Stremio

```text
https://vlxx-phd-addon.onrender.com/manifest.json
```

Kiểm tra trước bằng:

```text
https://vlxx-phd-addon.onrender.com/health
```

## Lưu ý

Render Free có thể spin down khi không có truy cập, nên lần mở đầu sau thời gian nghỉ có thể chậm. Session proxy media hiện lưu trong RAM của process; sau restart/redeploy, stream đang mở có thể cần mở lại. Không cần chạy Cloudflare Tunnel hoặc Windows Service trên laptop khi dùng Render.
