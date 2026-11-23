# Stickman Relay Server — 5-Digit Room ID WebSocket Relay

Máy chủ WebSocket Relay tốc độ cao hỗ trợ **Mã phòng 5 số (`10000`–`99999`)**, tối đa **4 người chơi/phòng**, chuyển tiếp gói tin nhị phân chống giả mạo (`peer_id`) cho **Shinjuku Showdown (Godot 4.7.2)**.

High-speed WebSocket binary relay server with **5-digit Room IDs (`10000`–`99999`)**, up to **4 players per room**, anti-spoof binary forwarding, and `/health` monitoring.

---

## 1. Chạy thử trên máy cá nhân / Run Locally (4 bước / 4 Steps)

1. Mở terminal tại thư mục `stickman_relay_server/`:
   ```bash
   cd stickman_relay_server
   ```
2. Cài thư viện phụ thuộc (`ws`):
   ```bash
   npm install
   ```
3. Khởi động server (mặc định cổng `8080`):
   ```bash
   node server.js
   ```
4. Kiểm tra trạng thái hoạt động:
   - Mở trình duyệt tới `http://127.0.0.1:8080/health` → nhận `{"status":"ok","rooms":0,"clients":0}`.
   - Trong game (**Phòng Online → Cấu hình Server URL**), nhập `ws://127.0.0.1:8080` (hoặc `ws://<IP-LAN-máy-bạn>:8080` cho thiết bị cùng Wi-Fi).

---

## 2. Triển khai miễn phí lên Render.com (Singapore) / Deploy to Render.com

1. Đẩy thư mục `stickman_relay_server/` lên một repository GitHub mới (riêng biệt với dự án Godot).
2. Đăng nhập [Render.com](https://render.com) → chọn **New + → Blueprint** (tự động đọc `render.yaml` với `region: singapore`, `plan: free`, `healthCheckPath: /health`) hoặc **New Web Service**.
3. Đợi Render build & deploy xong (khoảng 1–2 phút), kiểm tra `https://<ten-app>.onrender.com/health` trả về `{"status":"ok",...}`.
4. Trong game (**Phòng Online → Cấu hình Server URL**), đổi URL thành:
   ```
   wss://<ten-app>.onrender.com
   ```
   *(Lưu ý: dùng `wss://` vì Render bật TLS tự động; không cần ghi `:8080`.)*

---

## 3. Triển khai siêu mượt lên Fly.io (Singapore `sin`) / Deploy to Fly.io

1. Cài `flyctl` và đăng nhập:
   ```bash
   fly auth login
   ```
2. Khởi tạo app tại thư mục `stickman_relay_server/` (chọn region **`sin` — Singapore** cho ping Việt Nam thấp nhất ~25–40 ms):
   ```bash
   fly launch --region sin --no-deploy
   ```
3. Đẩy bản Docker lên Fly.io (sử dụng sẵn `Dockerfile` tối giản `node:20-alpine`):
   ```bash
   fly deploy
   ```
4. Kiểm tra `https://<ten-app>.fly.dev/health` rồi nhập vào game:
   ```
   wss://<ten-app>.fly.dev
   ```

---

## Giao thức ngắn gọn / Protocol Summary

- **Health Check:** `GET /health` → `200 OK` `{ "status": "ok", "rooms": 0, "clients": 0 }`
- **Control JSON:** `CREATE_ROOM`, `JOIN_ROOM`, `SET_LOCKED`, `PING`/`PONG`, `DISCONNECT_PEER`
- **Binary Frame (9-byte header + payload):**
  `[0x01][target_peer: int32 LE][sender_peer: int32 LE][payload bytes]`
  *(Server ghi đè `sender_peer` bằng `ws.peerId` xác thực để chống giả mạo.)*
