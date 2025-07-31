# LINE Bot Medicine Reminder Server

這是一個用於藥品提醒的 LINE Bot 服務器，與 Flutter 應用程式整合。

## 功能特色

- 📋 **今日提醒**：查看今日所有服藥提醒
- 💊 **記錄服藥**：透過按鈕快速記錄服藥
- 📊 **查看記錄**：查看最近的服藥記錄
- 👤 **帳戶資訊**：查看帳戶狀態和統計
- 🔗 **連接 App**：與 Flutter 應用程式同步
- ❓ **使用說明**：詳細的功能說明

## 技術架構

- **Node.js** + **Express.js**：後端服務器
- **LINE Messaging API**：LINE Bot 功能
- **Firebase Admin SDK**：資料庫整合
- **Render**：雲端部署平台

## 部署

### 環境變數設定

在 Render 中設定以下環境變數：

```
LINE_CHANNEL_ACCESS_TOKEN=your_line_channel_access_token
LINE_CHANNEL_SECRET=your_line_channel_secret
FIREBASE_SERVICE_ACCOUNT=your_firebase_service_account_json
```

### 啟動指令

```bash
npm start
```

## API 端點

- `GET /`：健康檢查
- `GET /health`：詳細健康狀態
- `GET /env-check`：環境變數檢查
- `POST /webhook`：LINE Webhook 處理
- `POST /send-reminder`：發送提醒通知

## 使用方式

1. 在 LINE 中發送任何訊息
2. Bot 會自動顯示主選單
3. 點擊按鈕進行操作
4. 所有功能都支援按鈕操作，適合老人家使用

## 開發

```bash
# 安裝依賴
npm install

# 開發模式
npm run dev

# 生產模式
npm start
``` 