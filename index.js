const express = require('express');
const line = require('@line/bot-sdk');
const admin = require('firebase-admin');
const app = express();
const port = process.env.PORT || 3000;

// 添加 JSON 解析中間件
app.use(express.json());

// LINE Bot 設定
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || 'YOUR_CHANNEL_ACCESS_TOKEN',
  channelSecret: process.env.LINE_CHANNEL_SECRET || 'YOUR_CHANNEL_SECRET'
};

// Firebase Admin SDK 初始化
let db;
try {
  // 簡化初始化過程
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: serviceAccount.project_id
    });
  } else {
    // 使用預設憑證
    admin.initializeApp();
  }
  db = admin.firestore();
  console.log('✅ Firebase Admin SDK 初始化成功');
} catch (error) {
  console.error('❌ Firebase Admin SDK 初始化失敗:', error);
  db = null;
}

// 檢查 LINE Bot 設定
console.log('=== LINE Bot 設定檢查 ===');
console.log('Channel Access Token:', config.channelAccessToken ? '已設定' : '未設定');
console.log('Channel Secret:', config.channelSecret ? '已設定' : '未設定');
console.log('Firebase 狀態:', db ? '已連接' : '未連接');

// 安全地初始化 LINE Client
let client;
try {
  client = new line.Client(config);
  console.log('✅ LINE Client 初始化成功');
} catch (error) {
  console.error('❌ LINE Client 初始化失敗:', error);
  client = null;
}

// 根路徑 - 健康檢查
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'LINE Bot Medicine Reminder Server is running',
    timestamp: new Date().toISOString()
  });
});

// 健康檢查端點
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// LINE Webhook 處理
app.post('/webhook', (req, res) => {
  console.log('=== 收到 LINE Webhook 請求 ===');
  
  // 立即返回 200 狀態碼
  res.status(200).json({ status: 'ok', message: 'Webhook received' });
  
  // 檢查是否有事件
  if (!req.body || !req.body.events) {
    console.log('❌ 沒有事件資料');
    return;
  }
  
  console.log('✅ 事件數量:', req.body.events.length);
  
  // 處理事件
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => {
      console.log('✅ 事件處理完成:', result);
    })
    .catch((err) => {
      console.error('❌ Webhook 處理錯誤:', err);
    });
});

// 處理 LINE 事件
async function handleEvent(event) {
  try {
    console.log('處理事件:', event.type);
    
    if (event.type === 'message') {
      if (event.message.type === 'text') {
        return handleTextMessage(event);
      }
    } else if (event.type === 'postback') {
      return handlePostback(event);
    }

    console.log('未處理的事件:', event);
    return Promise.resolve(null);
  } catch (error) {
    console.error('事件處理錯誤:', error);
    return Promise.resolve(null);
  }
}

// 處理文字訊息
async function handleTextMessage(event) {
  try {
    console.log('處理文字訊息:', event.message.text);
    
    const userMessage = event.message.text;
    const userId = event.source.userId;

    // 檢查是否有正確的 Token 和 Client
    if (!client || !config.channelAccessToken || config.channelAccessToken === 'YOUR_CHANNEL_ACCESS_TOKEN') {
      console.log('LINE 設定不完整，無法回覆訊息');
      return Promise.resolve(null);
    }

    // 檢查並建立使用者帳戶
    await ensureUserAccount(userId);

    let replyMessage;
    
    if (userMessage === '你好' || userMessage === 'hi' || userMessage === 'hello') {
      replyMessage = {
        type: 'text',
        text: '您好！我是您的藥品提醒助手。\n\n請選擇您需要的功能：',
        quickReply: {
          items: [
            {
              type: 'action',
              action: {
                type: 'postback',
                label: '📋 今日提醒',
                data: 'action=show_today_reminders'
              }
            },
            {
              type: 'action',
              action: {
                type: 'postback',
                label: '💊 記錄服藥',
                data: 'action=record_medicine'
              }
            },
            {
              type: 'action',
              action: {
                type: 'postback',
                label: '📊 查看記錄',
                data: 'action=show_records'
              }
            },
            {
              type: 'action',
              action: {
                type: 'postback',
                label: '👤 帳戶資訊',
                data: 'action=show_account'
              }
            },
            {
              type: 'action',
              action: {
                type: 'postback',
                label: '🔗 連接 App',
                data: 'action=connect_app'
              }
            }
          ]
        }
      };
    } else if (userMessage.includes('提醒') || userMessage.includes('今日')) {
      return showTodayReminders(event);
    } else if (userMessage.includes('記錄') || userMessage.includes('服藥')) {
      return showMedicineRecords(event);
    } else if (userMessage.includes('帳戶') || userMessage.includes('連接') || userMessage.includes('綁定')) {
      return showAccountInfo(event);
    } else if (userMessage.includes('選單') || userMessage.includes('功能') || userMessage.includes('幫助')) {
      return showMainMenu(event);
    } else {
      // 預設顯示主選單 - 所有其他訊息都顯示主選單
      return showMainMenu(event);
    }

    return client.replyMessage(event.replyToken, replyMessage);
  } catch (error) {
    console.error('處理文字訊息錯誤:', error);
    return Promise.resolve(null);
  }
}

// 確保使用者帳戶存在
async function ensureUserAccount(lineUserId) {
  if (!db) {
    console.error('Firebase 不可用，無法建立帳戶');
    return;
  }

  try {
    // 檢查是否已存在該 LINE User ID 的綁定
    const existingBinding = await db.collection('bindings').where('lineUserId', '==', lineUserId).get();
    
    if (existingBinding.empty) {
      // 建立新綁定（使用 LINE ID 作為文檔 ID）
      const newBindingRef = db.collection('bindings').doc();
      await newBindingRef.set({
        appUserId: null, // 暫時為 null，等待 App 用戶綁定
        lineUserId: lineUserId,
        boundAt: admin.firestore.FieldValue.serverTimestamp(),
        lastActiveAt: admin.firestore.FieldValue.serverTimestamp(),
        source: 'line_bot'
      });
      
      console.log(`✅ 已為 LINE User ID ${lineUserId} 建立新綁定: ${newBindingRef.id}`);
    } else {
      // 更新最後活動時間
      const bindingDoc = existingBinding.docs[0];
      await bindingDoc.ref.update({
        lastActiveAt: admin.firestore.FieldValue.serverTimestamp()
      });
      
      console.log(`✅ 找到現有綁定: ${bindingDoc.id}`);
    }
  } catch (error) {
    console.error('建立使用者綁定錯誤:', error);
  }
}

// 顯示帳戶資訊
async function showAccountInfo(event) {
  try {
    const userId = event.source.userId;
    
    if (!db) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '❌ 資料庫連接失敗，請稍後再試'
      });
    }

    // 確保帳戶存在
    await ensureUserAccount(userId);

    // 獲取帳戶資訊
    const lineUserRef = db.collection('users').where('lineUserId', '==', userId);
    const lineUserSnapshot = await lineUserRef.get();
    
    if (lineUserSnapshot.empty) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '❌ 找不到您的帳戶'
      });
    }

    const userDoc = lineUserSnapshot.docs[0];
    const userData = userDoc.data();
    
    // 獲取提醒數量
    const remindersRef = db.collection('users').doc(userDoc.id).collection('reminders');
    const remindersSnapshot = await remindersRef.get();
    
    // 獲取服藥記錄數量
    const recordsRef = db.collection('users').doc(userDoc.id).collection('medicine_records');
    const recordsSnapshot = await recordsRef.get();
    
    const createdAt = userData.createdAt ? userData.createdAt.toDate().toLocaleDateString('zh-TW') : '未知';
    
    let message = '👤 帳戶資訊\n\n';
    message += `📱 LINE ID: ${userId}\n`;
    message += `🆔 帳戶 ID: ${userDoc.id}\n`;
    message += `📅 建立時間: ${createdAt}\n`;
    message += `💊 提醒數量: ${remindersSnapshot.size} 個\n`;
    message += `📊 服藥記錄: ${recordsSnapshot.size} 筆\n`;
    message += `🔗 連接狀態: ✅ 已連接\n\n`;
    message += '💡 提示：您可以在 App 中管理提醒和查看詳細記錄。';

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: message,
      quickReply: {
        items: [
          {
            type: 'action',
            action: {
              type: 'postback',
              label: '📋 今日提醒',
              data: 'action=show_today_reminders'
            }
          },
          {
            type: 'action',
            action: {
              type: 'postback',
              label: '📊 查看記錄',
              data: 'action=show_records'
            }
          },
          {
            type: 'action',
            action: {
              type: 'postback',
              label: '🏠 主選單',
              data: 'action=show_main_menu'
            }
          }
        ]
      }
    });
  } catch (error) {
    console.error('顯示帳戶資訊錯誤:', error);
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '❌ 獲取帳戶資訊失敗，請稍後再試'
    });
  }
}

// 顯示主選單
async function showMainMenu(event) {
  try {
    const userId = event.source.userId;
    
    if (!client) {
      console.error('LINE Client 不可用');
      return Promise.resolve(null);
    }

    // 確保使用者帳戶存在
    await ensureUserAccount(userId);

    const message = {
      type: 'text',
      text: '🏥 藥品提醒助手\n\n請選擇您需要的功能：',
      quickReply: {
        items: [
          {
            type: 'action',
            action: {
              type: 'postback',
              label: '📋 今日提醒',
              data: 'action=show_today_reminders'
            }
          },
          {
            type: 'action',
            action: {
              type: 'postback',
              label: '💊 記錄服藥',
              data: 'action=record_medicine'
            }
          },
          {
            type: 'action',
            action: {
              type: 'postback',
              label: '📊 查看記錄',
              data: 'action=show_records'
            }
          },
          {
            type: 'action',
            action: {
              type: 'postback',
              label: '👤 帳戶資訊',
              data: 'action=show_account'
            }
          },
          {
            type: 'action',
            action: {
              type: 'postback',
              label: '🔗 連接 App',
              data: 'action=connect_app'
            }
          },
          {
            type: 'action',
            action: {
              type: 'postback',
              label: '❓ 使用說明',
              data: 'action=show_help'
            }
          }
        ]
      }
    };

    return client.replyMessage(event.replyToken, message);
  } catch (error) {
    console.error('顯示主選單錯誤:', error);
    return Promise.resolve(null);
  }
}

// 顯示連接 App 說明
async function showConnectAppInfo(event) {
  try {
    const userId = event.source.userId;
    
    if (!client) {
      console.error('LINE Client 不可用');
      return Promise.resolve(null);
    }

    let message = '🔗 連接 App 說明\n\n';
    message += '📱 在您的 App 中：\n';
    message += '1. 點擊「LINE 設定」\n';
    message += '2. 選擇「使用測試帳戶」\n';
    message += '3. 或輸入您的 LINE ID\n\n';
    message += '💡 連接後即可：\n';
    message += '• 同步接收提醒\n';
    message += '• 雙向記錄服藥\n';
    message += '• 查看完整記錄\n\n';
    message += '🆔 您的 LINE ID：\n';
    message += `${userId}`;

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: message,
      quickReply: {
        items: [
          {
            type: 'action',
            action: {
              type: 'postback',
              label: '📋 今日提醒',
              data: 'action=show_today_reminders'
            }
          },
          {
            type: 'action',
            action: {
              type: 'postback',
              label: '📊 查看記錄',
              data: 'action=show_records'
            }
          },
          {
            type: 'action',
            action: {
              type: 'postback',
              label: '🏠 主選單',
              data: 'action=show_main_menu'
            }
          }
        ]
      }
    });
  } catch (error) {
    console.error('顯示連接 App 說明錯誤:', error);
    return Promise.resolve(null);
  }
}

// 顯示使用說明
async function showHelp(event) {
  try {
    const userId = event.source.userId;
    
    if (!client) {
      console.error('LINE Client 不可用');
      return Promise.resolve(null);
    }

    let message = '❓ 使用說明\n\n';
    message += '📋 今日提醒：\n';
    message += '• 查看今日所有服藥提醒\n';
    message += '• 點擊按鈕確認服藥\n\n';
    message += '💊 記錄服藥：\n';
    message += '• 查看最近服藥記錄\n';
    message += '• 了解服藥狀況\n\n';
    message += '📊 查看記錄：\n';
    message += '• 查看詳細服藥記錄\n';
    message += '• 追蹤服藥歷史\n\n';
    message += '👤 帳戶資訊：\n';
    message += '• 查看帳戶狀態\n';
    message += '• 統計資訊\n\n';
    message += '🔗 連接 App：\n';
    message += '• 與手機 App 同步\n';
    message += '• 雙向資料同步';

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: message,
      quickReply: {
        items: [
          {
            type: 'action',
            action: {
              type: 'postback',
              label: '📋 今日提醒',
              data: 'action=show_today_reminders'
            }
          },
          {
            type: 'action',
            action: {
              type: 'postback',
              label: '🔗 連接 App',
              data: 'action=connect_app'
            }
          },
          {
            type: 'action',
            action: {
              type: 'postback',
              label: '🏠 主選單',
              data: 'action=show_main_menu'
            }
          }
        ]
      }
    });
  } catch (error) {
    console.error('顯示使用說明錯誤:', error);
    return Promise.resolve(null);
  }
}

// 處理按鈕點擊事件
async function handlePostback(event) {
  try {
    console.log('處理按鈕點擊:', event.postback.data);
    
    const data = event.postback.data;
    const userId = event.source.userId;

    if (!client) {
      console.error('LINE Client 不可用');
      return Promise.resolve(null);
    }

    // 確保使用者帳戶存在
    await ensureUserAccount(userId);

    if (data === 'action=show_today_reminders') {
      return showTodayReminders(event);
    } else if (data === 'action=record_medicine') {
      return showMedicineRecords(event);
    } else if (data === 'action=show_records') {
      return showMedicineRecords(event);
    } else if (data === 'action=show_account') {
      return showAccountInfo(event);
    } else if (data === 'action=connect_app') {
      return showConnectAppInfo(event);
    } else if (data === 'action=show_main_menu') {
      return showMainMenu(event);
    } else if (data === 'action=show_help') {
      return showHelp(event);
    } else if (data.startsWith('action=taken_')) {
      const reminderId = data.replace('action=taken_', '');
      return recordMedicineTaken(event, reminderId);
    } else if (data.startsWith('action=delay_')) {
      const reminderId = data.replace('action=delay_', '');
      return delayMedicineReminder(event, reminderId);
    } else if (data.startsWith('action=skip_')) {
      const reminderId = data.replace('action=skip_', '');
      return skipMedicineReminder(event, reminderId);
  }

    // 如果沒有匹配的操作，顯示主選單
    return showMainMenu(event);
  } catch (error) {
    console.error('處理按鈕點擊錯誤:', error);
    return Promise.resolve(null);
  }
}

// 顯示今日提醒
async function showTodayReminders(event) {
  try {
    const userId = event.source.userId;
    
    if (!db) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '❌ 資料庫連接失敗，請稍後再試'
      });
    }

    // 從 Firebase 獲取使用者的 LINE ID 對應的 Firebase UID
    const lineUserRef = db.collection('users').where('lineUserId', '==', userId);
    const lineUserSnapshot = await lineUserRef.get();
    
    if (lineUserSnapshot.empty) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '❌ 找不到您的帳戶，請先在 App 中連接 LINE'
      });
    }

    const firebaseUid = lineUserSnapshot.docs[0].id;
    
    // 獲取今日提醒
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    
    const remindersRef = db.collection('users').doc(firebaseUid).collection('reminders');
    const remindersSnapshot = await remindersRef.get();
    
    if (remindersSnapshot.empty) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '📋 今日提醒\n\n✅ 目前沒有設定任何提醒',
        quickReply: {
          items: [
            {
              type: 'action',
              action: {
                type: 'postback',
                label: '🔗 連接 App',
                data: 'action=connect_app'
              }
            },
            {
              type: 'action',
              action: {
                type: 'postback',
                label: '🏠 主選單',
                data: 'action=show_main_menu'
              }
            }
          ]
        }
      });
    }

    let message = '📋 今日提醒\n\n';
    const quickReplyItems = [];

    remindersSnapshot.forEach((doc) => {
      const reminder = doc.data();
      const reminderTime = `${reminder.hour.toString().padStart(2, '0')}:${reminder.minute.toString().padStart(2, '0')}`;
      
      message += `💊 ${reminderTime} - ${reminder.medicineName}\n`;
      message += `   劑量：${reminder.dosage}\n\n`;
      
      // 為每個提醒添加按鈕
      quickReplyItems.push(
        {
          type: 'action',
          action: {
            type: 'postback',
            label: `✅ ${reminderTime} 已服藥`,
            data: `action=taken_${doc.id}`
          }
        },
        {
          type: 'action',
          action: {
            type: 'postback',
            label: `⏰ ${reminderTime} 延遲`,
            data: `action=delay_${doc.id}`
          }
        },
        {
          type: 'action',
          action: {
            type: 'postback',
            label: `⏭️ ${reminderTime} 跳過`,
            data: `action=skip_${doc.id}`
          }
        }
      );
    });

    // 添加返回主選單按鈕
    quickReplyItems.push({
      type: 'action',
      action: {
        type: 'postback',
        label: '🏠 主選單',
        data: 'action=show_main_menu'
      }
    });

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: message,
      quickReply: {
        items: quickReplyItems.slice(0, 13) // LINE 限制最多 13 個按鈕
      }
    });
  } catch (error) {
    console.error('顯示今日提醒錯誤:', error);
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '❌ 獲取提醒失敗，請稍後再試'
    });
  }
}

// 顯示服藥記錄
async function showMedicineRecords(event) {
  try {
    const userId = event.source.userId;
    
    if (!db) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '❌ 資料庫連接失敗，請稍後再試'
      });
    }

    // 從 Firebase 獲取使用者的 LINE ID 對應的 Firebase UID
    const lineUserRef = db.collection('users').where('lineUserId', '==', userId);
    const lineUserSnapshot = await lineUserRef.get();
    
    if (lineUserSnapshot.empty) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '❌ 找不到您的帳戶，請先在 App 中連接 LINE'
      });
    }

    const firebaseUid = lineUserSnapshot.docs[0].id;
    
    // 獲取最近的服藥記錄
    const recordsRef = db.collection('users').doc(firebaseUid).collection('medicine_records');
    const recordsSnapshot = await recordsRef.orderBy('date', 'desc').limit(5).get();
    
    if (recordsSnapshot.empty) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '📊 服藥記錄\n\n📝 目前沒有服藥記錄',
        quickReply: {
          items: [
            {
              type: 'action',
              action: {
                type: 'postback',
                label: '📋 今日提醒',
                data: 'action=show_today_reminders'
              }
            },
            {
              type: 'action',
              action: {
                type: 'postback',
                label: '🏠 主選單',
                data: 'action=show_main_menu'
              }
            }
          ]
        }
      });
    }

    let message = '📊 最近服藥記錄\n\n';
    
    recordsSnapshot.forEach((doc) => {
      const record = doc.data();
      const date = new Date(record.date).toLocaleDateString('zh-TW');
      const time = record.time || '未記錄時間';
      
      message += `📅 ${date} ${time}\n`;
      message += `💊 ${record.medicineName}\n`;
      message += `💊 劑量：${record.dosage}\n`;
      if (record.notes) {
        message += `📝 備註：${record.notes}\n`;
      }
      message += '\n';
    });

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: message,
      quickReply: {
        items: [
          {
            type: 'action',
            action: {
              type: 'postback',
              label: '📋 今日提醒',
              data: 'action=show_today_reminders'
            }
          },
          {
            type: 'action',
            action: {
              type: 'postback',
              label: '💊 記錄服藥',
              data: 'action=record_medicine'
            }
          },
          {
            type: 'action',
            action: {
              type: 'postback',
              label: '🏠 主選單',
              data: 'action=show_main_menu'
            }
          }
        ]
      }
    });
  } catch (error) {
    console.error('顯示服藥記錄錯誤:', error);
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '❌ 獲取記錄失敗，請稍後再試'
    });
  }
}

// 記錄已服藥
async function recordMedicineTaken(event, reminderId) {
  try {
    const userId = event.source.userId;
    
    if (!db) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '❌ 資料庫連接失敗，請稍後再試'
      });
    }

    // 從 Firebase 獲取使用者的 LINE ID 對應的 Firebase UID
    const lineUserRef = db.collection('users').where('lineUserId', '==', userId);
    const lineUserSnapshot = await lineUserRef.get();
    
    if (lineUserSnapshot.empty) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '❌ 找不到您的帳戶，請先在 App 中連接 LINE'
      });
    }

    const firebaseUid = lineUserSnapshot.docs[0].id;
    
    // 獲取提醒資訊
    const reminderRef = db.collection('users').doc(firebaseUid).collection('reminders').doc(reminderId);
    const reminderDoc = await reminderRef.get();
    
    if (!reminderDoc.exists) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '❌ 找不到該提醒'
      });
    }

    const reminder = reminderDoc.data();
    
    // 記錄服藥
    const now = new Date();
    const recordData = {
      medicineName: reminder.medicineName,
      dosage: reminder.dosage,
      date: now.toISOString().split('T')[0],
      time: now.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }),
      notes: '透過 LINE 記錄',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('users').doc(firebaseUid).collection('medicine_records').add(recordData);

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `✅ 已記錄服藥\n\n💊 ${reminder.medicineName}\n💊 劑量：${reminder.dosage}\n⏰ 時間：${recordData.time}`,
      quickReply: {
        items: [
          {
            type: 'action',
            action: {
              type: 'postback',
              label: '📋 今日提醒',
              data: 'action=show_today_reminders'
            }
          },
          {
            type: 'action',
            action: {
              type: 'postback',
              label: '📊 查看記錄',
              data: 'action=show_records'
            }
          },
          {
            type: 'action',
            action: {
              type: 'postback',
              label: '🏠 主選單',
              data: 'action=show_main_menu'
            }
          }
        ]
      }
    });
  } catch (error) {
    console.error('記錄服藥錯誤:', error);
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '❌ 記錄失敗，請稍後再試'
    });
  }
}

// 延遲提醒
async function delayMedicineReminder(event, reminderId) {
  try {
    const userId = event.source.userId;
    
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '⏰ 已延遲提醒\n\n提醒將在 30 分鐘後再次發送',
      quickReply: {
        items: [
          {
            type: 'action',
            action: {
              type: 'postback',
              label: '📋 今日提醒',
              data: 'action=show_today_reminders'
            }
          },
          {
            type: 'action',
            action: {
              type: 'postback',
              label: '🏠 主選單',
              data: 'action=show_main_menu'
            }
          }
        ]
      }
    });
  } catch (error) {
    console.error('延遲提醒錯誤:', error);
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '❌ 延遲失敗，請稍後再試'
    });
  }
}

// 跳過提醒
async function skipMedicineReminder(event, reminderId) {
  try {
    const userId = event.source.userId;
    
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '⏭️ 已跳過提醒\n\n下次提醒時間：明天',
      quickReply: {
        items: [
          {
            type: 'action',
            action: {
              type: 'postback',
              label: '📋 今日提醒',
              data: 'action=show_today_reminders'
            }
          },
          {
            type: 'action',
            action: {
              type: 'postback',
              label: '🏠 主選單',
              data: 'action=show_main_menu'
            }
          }
        ]
      }
    });
  } catch (error) {
    console.error('跳過提醒錯誤:', error);
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '❌ 跳過失敗，請稍後再試'
    });
  }
}

// 發送提醒通知的 API 端點
app.post('/send-reminder', async (req, res) => {
  try {
    const { lineUserId, reminder } = req.body;
    
    if (!lineUserId || !reminder) {
      return res.status(400).json({ error: '缺少必要參數' });
    }

    if (!client) {
      return res.status(500).json({ error: 'LINE Client 不可用' });
    }

    const reminderTime = `${reminder.hour.toString().padStart(2, '0')}:${reminder.minute.toString().padStart(2, '0')}`;
    
    const message = {
      type: 'text',
      text: `⏰ 服藥提醒\n\n💊 ${reminder.medicineName}\n💊 劑量：${reminder.dosage}\n⏰ 時間：${reminderTime}`,
      quickReply: {
        items: [
          {
            type: 'action',
            action: {
              type: 'postback',
              label: '✅ 已服藥',
              data: `action=taken_${reminder.id}`
            }
          },
          {
            type: 'action',
            action: {
              type: 'postback',
              label: '⏰ 延遲提醒',
              data: `action=delay_${reminder.id}`
            }
          },
          {
            type: 'action',
            action: {
              type: 'postback',
              label: '⏭️ 跳過提醒',
              data: `action=skip_${reminder.id}`
            }
          }
        ]
      }
    };

    await client.pushMessage(lineUserId, message);
    
    res.json({ success: true, message: '提醒已發送' });
  } catch (error) {
    console.error('發送提醒錯誤:', error);
    res.status(500).json({ error: '發送提醒失敗' });
  }
});

// 環境變數檢查端點
app.get('/env-check', (req, res) => {
  res.json({
    status: 'ok',
    lineTokenSet: !!config.channelAccessToken && config.channelAccessToken !== 'YOUR_CHANNEL_ACCESS_TOKEN',
    lineSecretSet: !!config.channelSecret && config.channelSecret !== 'YOUR_CHANNEL_SECRET',
    tokenLength: config.channelAccessToken ? config.channelAccessToken.length : 0,
    secretLength: config.channelSecret ? config.channelSecret.length : 0,
    clientAvailable: !!client,
    firebaseAvailable: !!db
  });
});

app.listen(port, () => {
  console.log(`✅ LINE Bot 服務器運行在 port ${port}`);
  console.log(`🌐 健康檢查: http://localhost:${port}/health`);
  console.log(`🔗 Webhook: http://localhost:${port}/webhook`);
  console.log(`📊 環境檢查: http://localhost:${port}/env-check`);
});

// 錯誤處理
process.on('unhandledRejection', (reason, promise) => {
  console.error('未處理的 Promise 拒絕:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('未捕獲的異常:', error);
}); 