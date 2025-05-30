/**
 * NotionからのWebhookを受信する関数
 */

function doPost(e) {
  try {
    // リクエストボディを解析
    const requestBody = JSON.parse(e.postData.contents);

    writeLog('content: ' + JSON.stringify(requestBody, null, 2));
    
    // Notionからのデータを取得
    const pageId = extractPageId(requestBody); // ページIDを抽出
    const title = extractTitle(requestBody);
    const content = extractContent(requestBody);
    
    if (!pageId) {
      writeLog('ページIDが見つかりません');
      return ContentService.createTextOutput(JSON.stringify({
        status: 'error',
        message: 'ページIDが見つかりません'
      })).setMimeType(ContentService.MimeType.JSON);
    }
    
    if (!title || !content) {
      writeLog('タイトルまたは本文が見つかりません');
      return ContentService.createTextOutput(JSON.stringify({
        status: 'error',
        message: 'タイトルまたは本文が見つかりません'
      })).setMimeType(ContentService.MimeType.JSON);
    }
    
    // Geminiにリクエストを送信
    const comment = generateCommentWithGemini(title, content);
    
    // コメントをNotionに投稿
    postCommentToNotion(pageId, comment);
    
    console.log('生成されたコメント:', comment);
    console.log('コメントがNotionページに投稿されました:', pageId);
    
    return ContentService.createTextOutput(JSON.stringify({
      status: 'success',
      comment: comment,
      message: 'コメントがNotionに投稿されました'
    })).setMimeType(ContentService.MimeType.JSON);
    
  } catch (error) {
    console.error('エラーが発生しました:', error);
    
    // エラーログを記録
    writeLog(`エラーが発生しました: ${error.message}`);
    
    return ContentService.createTextOutput(JSON.stringify({
      status: 'error',
      message: error.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * NotionのWebhookデータからページIDを抽出
 */
function extractPageId(requestBody) {
  try {
    // ページIDの抽出ロジック
    if (requestBody.data && requestBody.data.id) {
      return requestBody.data.id;
    }

    console.warn('ページIDの抽出に失敗しました。Webhookのペイロードを確認してください:', JSON.stringify(requestBody, null, 2));
    return null;
  } catch (error) {
    console.error('ページID抽出エラー:', error);
    return null;
  }
}

/**
 * NotionのWebhookデータからタイトルを抽出
 */
function extractTitle(requestBody) {
  try {
    // Notionのwebhook構造に応じて調整が必要
    // 提供されたJSONの例では、data.properties 内の type: 'title' のプロパティから抽出
    if (requestBody.data && requestBody.data.properties) {
      // ページのタイトルプロパティを探す
      const titleProperty = Object.values(requestBody.data.properties)
        .find(prop => prop.type === 'title');
      
      if (titleProperty && titleProperty.title && titleProperty.title.length > 0) {
        // titleプロパティの最初の要素のplain_textを使用
        return titleProperty.title[0].plain_text; 
      }
    }
    
    console.warn('タイトルが見つかりませんでした。Webhookのペイロードを確認してください:', JSON.stringify(requestBody, null, 2));
    return null;
  } catch (error) {
    console.error('タイトル抽出エラー:', error);
    return null;
  }
}

/**
 * NotionのWebhookデータから本文を抽出
 */
function extractContent(requestBody) {
  try {
    const pageId = extractPageId(requestBody);
    if (!pageId) {
      console.warn('ページIDが見つからないため、本文を抽出できません。');
      return null;
    }

    const NOTION_TOKEN = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
    const NOTION_VERSION = '2022-06-28'; // Notion APIのバージョン

    if (!NOTION_TOKEN) {
      throw new Error('Notion API トークンが設定されていません');
    }

    const url = `https://api.notion.com/v1/blocks/${pageId}/children`;
    const options = {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      muteHttpExceptions: true
    };

    const response = UrlFetchApp.fetch(url, options);
    const responseCode = response.getResponseCode();
    const responseBody = response.getContentText();

    if (responseCode !== 200) {
      console.error(`Notion API エラー (ブロック取得 - コード: ${responseCode}):`, responseBody);
      throw new Error(`ページの本文取得に失敗しました。ステータスコード: ${responseCode}, レスポンス: ${responseBody}`);
    }

    const data = JSON.parse(responseBody);
    let content = '';

    if (data.results && data.results.length > 0) {
      data.results.forEach(block => {
        if (block.type === 'paragraph' && block.paragraph && block.paragraph.rich_text) {
          block.paragraph.rich_text.forEach(textItem => {
            if (textItem.type === 'text') {
              content += textItem.text.content + '\\n';
            }
          });
        }
      });
    }

    if (content.trim() === '') {
      console.warn('ページから本文コンテンツが見つかりませんでした。ページID:', pageId, 'APIレスポンス:', JSON.stringify(data, null, 2));
      return null;
    }

    return content.trim();
  } catch (error) {
    console.error('本文抽出エラー:', error);
    // エラーログを記録
    writeLog(`本文抽出エラー: ${error.message} - pageId: ${extractPageId(requestBody)}`);
    return null;
  }
}

/**
 * Geminiにコメントリクエストを送信
 */
function generateCommentWithGemini(title, content) {
  const GEMINI_API_KEY = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  
  if (!GEMINI_API_KEY) {
    throw new Error('Gemini API キーが設定されていません');
  }
  
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`;
  
  const prompt = `以下の記事について、建設的で有益なコメントを日本語で生成してください。

タイトル: ${title}

本文:
${content}

コメントは以下の点を考慮してください:
- かわいく
- 鋭く
- ツッコんで

コメントのみを生成してください。`;

  const payload = {
    contents: [{
      parts: [{
        text: prompt
      }]
    }]
  };
  
  const options = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    payload: JSON.stringify(payload)
  };
  
  try {
    const response = UrlFetchApp.fetch(url, options);
    const responseData = JSON.parse(response.getContentText());
    
    if (responseData.candidates && responseData.candidates.length > 0) {
      return responseData.candidates[0].content.parts[0].text;
    } else {
      throw new Error('Geminiからのレスポンスが不正です');
    }
  } catch (error) {
    console.error('Gemini API エラー:', error);
    throw new Error('コメント生成に失敗しました: ' + error.toString());
  }
}

/**
 * Notionページにコメントを投稿する関数
 */
function postCommentToNotion(pageId, commentText) {
  const NOTION_TOKEN = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
  const NOTION_VERSION = '2022-06-28'; // Notion APIのバージョン

  if (!NOTION_TOKEN) {
    throw new Error('Notion API トークンが設定されていません');
  }

  const url = 'https://api.notion.com/v1/comments';

  const payload = {
    parent: { page_id: pageId },
    rich_text: [
      {
        type: 'text',
        text: {
          content: commentText,
        },
      },
    ],
  };

  const options = {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': NOTION_VERSION,
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true // エラーレスポンスも取得するため
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    const responseCode = response.getResponseCode();
    const responseBody = response.getContentText();

    if (responseCode === 200) {
      console.log('Notionへのコメント投稿成功:', responseBody);
    } else {
      console.error(`Notion API エラー (コード: ${responseCode}):`, responseBody);
      throw new Error(`Notionへのコメント投稿に失敗しました。ステータスコード: ${responseCode}, レスポンス: ${responseBody}`);
    }
  } catch (error) {
    console.error('Notion API 呼び出しエラー:', error);
    throw new Error('Notionへのコメント投稿中にエラーが発生しました: ' + error.toString());
  }
}

/**
 * ログ書き出し設定を管理する関数群
 */
function enableLogging() {
  const scriptProperties = PropertiesService.getScriptProperties();
  scriptProperties.setProperty('LOGGING_ENABLED', 'true');
  console.log('ログ書き出しを有効にしました');
}

function disableLogging() {
  const scriptProperties = PropertiesService.getScriptProperties();
  scriptProperties.setProperty('LOGGING_ENABLED', 'false');
  console.log('ログ書き出しを無効にしました');
}

function isLoggingEnabled() {
  const scriptProperties = PropertiesService.getScriptProperties();
  const enabled = scriptProperties.getProperty('LOGGING_ENABLED');
  return enabled === 'true';
}

// ログを書き出す関数（文字列ログを記録）
function writeLog(log) {
  // ログ書き出しが有効かチェック
  if (!isLoggingEnabled()) {
    console.log('ログ書き出しが無効のため、スキップします');
    return;
  }

  const scriptProperties = PropertiesService.getScriptProperties();
  const timestamp = new Date().toISOString();
  const logKey = `log_${timestamp}`;
  const logValue = `${log}`;
  
  scriptProperties.setProperty(logKey, logValue);
  console.log(`ログを保存しました: ${logKey}`);
}

// エラーが発生する可能性のある処理の例
function myFunctionWithConditionalLogging() {
  try {
    // エラーが発生する可能性のあるコード
    const data = undefined;
    console.log(data.length); // ここでエラーが発生します
  } catch (e) {
    // 設定に基づいてエラーログを書き出し
    writeLog(`エラーが発生しました: ${e.message}`);
    
    // 必要に応じてエラーを再スローするか、他の処理を行う
    console.error('エラーが発生しました:', e.message);
  }
}

// 保存されたログを表示する関数
function showLogs() {
  const scriptProperties = PropertiesService.getScriptProperties();
  const keys = scriptProperties.getKeys();
  const logKeys = keys.filter(key => key.startsWith("log_"));
  
  if (logKeys.length === 0) {
    console.log('保存されたログはありません');
    return;
  }
  
  logKeys.forEach(key => {
    console.log(`Key: ${key}\nValue:\n${scriptProperties.getProperty(key)}\n---`);
  });
}

// エラーログのみを表示する関数（後方互換性のため）
function showErrorLogs() {
  showLogs();
}

// ログをクリアする関数
function clearLogs() {
  const scriptProperties = PropertiesService.getScriptProperties();
  const keys = scriptProperties.getKeys();
  const logKeys = keys.filter(key => key.startsWith("log_"));
  
  logKeys.forEach(key => {
    scriptProperties.deleteProperty(key);
  });
  
  console.log(`${logKeys.length}件のログをクリアしました`);
}

// エラーログのみをクリアする関数（後方互換性のため）
function clearErrorLogs() {
  clearLogs();
}

/**
 * テスト用関数
 */
function testWebhook() {
  const mockPageId = 'YOUR_TEST_PAGE_ID'; // ★★★ テスト用のNotionページIDに置き換えてください ★★★

  // NotionインテグレーションがこのページIDにアクセスできるように共有設定を確認してください。

  const mockRequest = {
    postData: {
      contents: JSON.stringify({
        // page_id を含むようにペイロードを調整
        // 実際のWebhookペイロードに合わせてください
        page_id: mockPageId, // または data: { id: mockPageId } など
        data: { // extractPageId が data.id を見る場合
            id: mockPageId,
            properties: {
              title: {
                type: 'title',
                title: [{
                  plain_text: 'テスト記事のタイトル'
                }]
              }
            },
            children: [{
              type: 'paragraph',
              paragraph: {
                rich_text: [{
                  plain_text: 'これはテスト記事の本文です。Google Apps ScriptとNotionの連携について説明しています。Geminiがコメントを生成し、Notionに投稿します。'
                }]
              }
            }]
        }
      })
    }
  };
  
  const result = doPost(mockRequest);
  console.log('テスト結果:', result.getContent());
}