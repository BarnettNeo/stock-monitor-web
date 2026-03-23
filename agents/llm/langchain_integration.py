"""
LangChain 2026 + ReAct 模式集成
简化版本，专注于工具调用和记忆管理
"""

import json
from typing import Any, Dict, List, Optional

from core.config import TOOLS_SPEC, SYSTEM_PROMPT
from llm.llm import call_openai_compatible, extract_json_object
from infrastructure.memory import memory
from core.models import ToolCall


class ReActAgent:
    """ReAct模式的Agent实现"""
    
    def __init__(self):
        self.tools_spec = TOOLS_SPEC
        self.system_prompt = SYSTEM_PROMPT
    
    def _build_react_prompt(self, user_message: str, history: List[Dict[str, Any]], tool_results: Optional[List[Dict[str, Any]]] = None) -> List[Dict[str, Any]]:
        """构建ReAct模式的提示词"""
        messages = [{"role": "system", "content": self.system_prompt}]
        
        # 添加历史对话
        for msg in history[-5:]:  # 只保留最近5轮对话
            if isinstance(msg, dict) and msg.get("role") in ("user", "assistant"):
                messages.append(msg)
        
        # 构建ReAct思考链
        react_prompt = f"""
你是一个使用ReAct（Reasoning and Acting）模式的股票监控AI助手。

对于用户的问题，请按以下步骤思考：

1. **Thought（思考）**: 分析用户意图，确定需要什么信息
2. **Action（行动）**: 选择合适的工具来获取信息
3. **Observation（观察）**: 分析工具返回的结果
4. **Answer（回答）**: 基于观察结果给出最终答案

可用工具：
{json.dumps(self.tools_spec, ensure_ascii=False, indent=2)}

用户问题：{user_message}

请按照以下JSON格式回复：
{{
    "thought": "你的思考过程",
    "action": "tool_calls" or "final",
    "tool_calls": [{{"id": "t1", "name": "工具名", "arguments": {{}}}}] or [],
    "answer": "最终答案（仅当action为final时）"
}}
"""
        
        messages.append({"role": "user", "content": react_prompt})
        
        # 如果有工具结果，添加到上下文
        if tool_results:
            tool_context = f"工具执行结果：{json.dumps(tool_results, ensure_ascii=False)}"
            messages.append({"role": "system", "content": tool_context})
        
        return messages
    
    async def think(self, user_message: str, user_id: str, tool_results: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
        """ReAct思考过程"""
        # 加载用户历史
        history = await memory.load(user_id)
        
        # 构建提示词
        messages = self._build_react_prompt(user_message, history, tool_results)
        
        # 调用LLM
        llm_response = await call_openai_compatible(messages, json_mode=True)
        
        if not llm_response.get("ok"):
            return {
                "ok": False,
                "error": f"LLM调用失败: {llm_response.get('error')}",
                "action": "final",
                "answer": "抱歉，我现在无法处理您的请求，请稍后再试。"
            }
        
        # 解析LLM响应
        response_text = llm_response.get("reply", "")
        parsed_response = extract_json_object(response_text)
        
        if not parsed_response:
            return {
                "ok": False,
                "error": "无法解析LLM响应",
                "action": "final",
                "answer": "抱歉，我无法理解您的请求，请换个说法。"
            }
        
        # 验证响应格式
        action = parsed_response.get("action", "final")
        thought = parsed_response.get("thought", "")
        answer = parsed_response.get("answer", "")
        tool_calls = parsed_response.get("tool_calls", [])
        
        result = {
            "ok": True,
            "thought": thought,
            "action": action,
            "answer": answer if action == "final" else "",
            "tool_calls": []
        }
        
        # 处理工具调用
        if action == "tool_calls" and isinstance(tool_calls, list):
            for i, tool_call in enumerate(tool_calls):
                if isinstance(tool_call, dict):
                    result["tool_calls"].append(ToolCall(
                        id=tool_call.get("id", f"t{i+1}"),
                        name=tool_call.get("name", ""),
                        arguments=tool_call.get("arguments", {})
                    ))
        
        return result
    
    async def observe(self, tool_results: List[Dict[str, Any]], user_id: str) -> str:
        """观察工具执行结果"""
        if not tool_results:
            return "没有工具执行结果。"
        
        observations = []
        for result in tool_results:
            if result.get("ok"):
                observations.append(f"✅ {result.get('name')}: 执行成功")
            else:
                observations.append(f"❌ {result.get('name')}: {result.get('error', '执行失败')}")
        
        return "\n".join(observations)
    
    async def answer(self, user_message: str, user_id: str, tool_results: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
        """完整的ReAct流程"""
        # 第一次思考
        thought_result = await self.think(user_message, user_id, tool_results)
        
        if not thought_result.get("ok"):
            return thought_result
        
        # 如果需要调用工具
        if thought_result.get("action") == "tool_calls":
            return {
                "ok": True,
                "thought": thought_result.get("thought"),
                "action": "tool_calls",
                "tool_calls": thought_result.get("tool_calls"),
                "answer": ""
            }
        
        # 如果是最终答案
        if thought_result.get("action") == "final":
            # 保存对话历史
            await memory.append(user_id, {"role": "user", "content": user_message})
            await memory.append(user_id, {"role": "assistant", "content": thought_result.get("answer")})
            
            return {
                "ok": True,
                "thought": thought_result.get("thought"),
                "action": "final",
                "tool_calls": [],
                "answer": thought_result.get("answer")
            }
        
        return {
            "ok": False,
            "error": "未知的action类型",
            "answer": "抱歉，处理您的请求时出现了问题。"
        }


class LangChainStyleAgent:
    """LangChain风格的Agent包装器"""
    
    def __init__(self):
        self.react_agent = ReActAgent()
    
    async def run(self, user_message: str, user_id: str, tool_results: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
        """运行Agent"""
        return await self.react_agent.answer(user_message, user_id, tool_results)
    
    def get_tool_spec(self) -> List[Dict[str, Any]]:
        """获取工具规格"""
        return self.react_agent.tools_spec


# 全局Agent实例
langchain_agent = LangChainStyleAgent()
