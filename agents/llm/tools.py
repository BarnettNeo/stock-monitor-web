from typing import Any, Dict, List

from core.models import ToolResult


def format_tool_results(tool_results: List[ToolResult]) -> str:
    """格式化工具执行结果（无LLM时的兜底显示）- 支持8个工具"""
    lines: List[str] = []
    for tr in tool_results:
        if not tr.ok:
            lines.append(f"- 工具 `{tr.name}` 执行失败：{tr.error or 'unknown error'}")
            continue

        # 1. 查询触发记录
        if tr.name == "query_triggers" and isinstance(tr.result, dict):

            triggers = tr.result.get("triggers", [])
            if isinstance(triggers, list) and triggers:
                lines.append(f"🔔 共 {len(triggers)} 条触发记录：")
                for i, t in enumerate(triggers[:10], start=1):
                    if isinstance(t, dict):
                        symbol = t.get("symbol")
                        alert_type = t.get("type")
                        time = t.get("time")
                        lines.append(f"{i}. {symbol} - {alert_type} ({time})")
            else:
                lines.append("🔔 暂无触发记录。")
        
        # 2. 获取诊断详情

        elif tr.name == "get_diagnostic" and isinstance(tr.result, dict):
            symbol = tr.result.get("symbol")
            diagnosis = tr.result.get("diagnosis", {})
            lines.append(f"🔍 {symbol} 诊断详情：")
            if isinstance(diagnosis, dict):
                for key, value in diagnosis.items():
                    lines.append(f"   • {key}: {value}")
        
        # 3. 更新订阅

        elif tr.name == "update_subscription" and isinstance(tr.result, dict):
            sub_type = tr.result.get("type")
            status = tr.result.get("status")
            lines.append(f"📱 {sub_type} 订阅已{status}。")
        
        # 4. 获取股票信息

        elif tr.name == "get_stock_info" and isinstance(tr.result, dict):
            stocks = tr.result.get("stocks", [])
            if isinstance(stocks, list):
                lines.append(f"📈 股票信息：")
                for stock in stocks:
                    if isinstance(stock, dict):
                        symbol = stock.get("symbol")
                        price = stock.get("price")
                        change = stock.get("change")
                        change_pct = stock.get("changePercent")
                        lines.append(f"   {symbol}: {price} ({change_pct}%)")
        
        # 5. 生成报告

        elif tr.name == "generate_report" and isinstance(tr.result, dict):
            report_type = tr.result.get("reportType")
            summary = tr.result.get("summary", {})
            lines.append(f"📊 {report_type} 报告已生成：")
            if isinstance(summary, dict):
                for key, value in summary.items():
                    lines.append(f"   • {key}: {value}")
        
        else:
            lines.append(f"✅ 工具 `{tr.name}` 执行成功。")

    return "(agents) LLM未配置，以下为工具执行结果：\n" + ("\n".join(lines) if lines else "(empty)")


def parse_tool_calls_from_llm_response(raw: str) -> List[Dict[str, Any]]:
    """从LLM响应中解析工具调用"""
    from llm.llm import extract_json_object
    
    obj = extract_json_object(raw) or {}
    tool_calls_raw = obj.get("toolCalls") or obj.get("tool_calls") or []
    calls: List[Dict[str, Any]] = []
    
    if isinstance(tool_calls_raw, list):
        for i, item in enumerate(tool_calls_raw):
            if not isinstance(item, dict):
                continue
            cid = str(item.get("id") or f"t{i+1}")
            name = str(item.get("name") or "")
            args = item.get("arguments")
            if not isinstance(args, dict):
                args = {}
            if name:
                calls.append({"id": cid, "name": name, "arguments": args})
    
    return calls


def parse_final_reply_from_llm_response(raw: str) -> str:
    """从LLM响应中解析最终回复"""
    from llm.llm import extract_json_object
    
    obj = extract_json_object(raw) or {}
    reply = str(obj.get("reply") or "").strip()
    if not reply:
        reply = "我已收到。你可以更具体一些（例如：想查询哪个策略/新增监控哪些股票/阈值是多少）。"
    return reply
