module.exports = {
  // 全局监控频率
  globalInterval: 10000, 

  // 所有的群组配置
  groups: [
    {
      id: "group_001", // 群唯一ID
      name: "种子群1", 
      enabled: true, // 是否开启该群监控
      marketTimeOnly: false, // 是否仅在交易时间运行
      pushType: "wecom", // 推送方式：dingtalk | wecom | both（默认 dingtalk）
      webhook: "https://oapi.dingtalk.com/robot/send?access_token=8b7ce7dd4d74211dddd9708a420415f13f604b671891eb217e965e1a571c1e2e", // 群机器人 webhook
      keyword: "股票", // 群机器人关键词
      secret: "SECxxx", // 加签用的密钥
      wecomWebhook: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=6bf4d0c0-fd26-457f-a31e-095d6e806bb4", // 企业微信机器人 webhook（pushType=wecom/both 时需要）
      wecomKeyword: "股票", // 企业微信机器人关键词（可选，不填则复用 keyword）
      stocks: [
        "sh603778",
        "sz300164",
        "sh601179",
        "sz000547",
        "sh600759",
        "sh600010"
      ],
      strategy: {
        priceAlertPercent: 2.0, // 价格异动触发百分比
        enableMacdGoldenCross: true, // 是否开启 MACD 金叉提醒
        enableRsiOversold: true, // 是否开启 RSI  Oversold 提醒
        enableRsiOverbought: true, // 是否开启 RSI  Overbought 提醒
        enableMovingAverages: false, // 是否开启 均线 提醒
        enablePatternSignal: true, // 是否开启 形态信号 提醒
        alertCooldownMinutes: 60, // 冷却时间（分钟）
        targetPricesUp: {
          // 示例：上行 1700 再提醒
          // "sh600519": 1700,
        },
        targetPricesDown: {
          // 示例：跌到 1500 以下再提醒
          "sh603778": 13.68,
          "sz300164": 12.00,
          "sh601179": 16.40,
          "sz000547": 29.00,
          // "sh600759": 7.00,
          "sh600010": 3.00
        }
      },
      checkIntervalMs: 60000
    },
    {
      id: "group_002",
      name: "种子群2",
      enabled: false, // 是否开启该群监控
      marketTimeOnly: true, // 是否仅在交易时间运行
      webhook: "https://oapi.dingtalk.com/robot/send?access_token=ee17545434108af0df6704840d9cad8892062969360203c42064acdb1a715771",
      keyword: "股票", // 群机器人关键词
      secret: "SECyyy",
      stocks: [
        "sh600519",
        "sh601318",
        "sh600036",
        "sh600759",
        "sh600916"
      ],
      strategy: {
        priceAlertPercent: 2.0,
        enableMacdGoldenCross: true,
        enableRsiOversold: true,
        enableRsiOverbought: true,
        enableMovingAverages: false, // 是否开启 均线 提醒
        alertCooldownMinutes: 60
      },
      checkIntervalMs: 60000
    },
    {
      id: "group_003",
      name: "种子群3",
      enabled: true, // 是否开启该群监控
      marketTimeOnly: true, // 是否仅在交易时间运行
      webhook: "https://oapi.dingtalk.com/robot/send?access_token=4418d999cfc408599ddfda38d45326ff29e5cc31670de3e30b998bbb4658d748",
      keyword: "股票", // 群机器人关键词
      secret: "SECyyy",
      stocks: [
        "sh603778",
        "sz300164",
        "sh601179",
        "sz000547",
        "sh600759",
        "sh600410"
      ],
      strategy: {
        priceAlertPercent: 2.0,
        enableMacdGoldenCross: false,
        enableRsiOversold: false,
        enableRsiOverbought: false,
        enableMovingAverages: false, // 是否开启 均线 提醒
        alertCooldownMinutes: 60,
        targetPricesDown: {
          // 示例：跌到目标值以下再提醒
          "sh603778": 13.68,
          "sz300164": 12.00,
          "sh601179": 16.40,
          "sz000547": 29.00,
          "sh600759": 5.60,
          "sh600410": 26.80
        }
      },
      checkIntervalMs: 60000
    }
    // ... 可以轻松扩展到 10 个
  ]
};
