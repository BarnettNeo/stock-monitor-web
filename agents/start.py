"""
Stock Monitor Agents 2026 启动脚本
支持Web服务、Celery Worker、Celery Beat的统一管理
"""

import os
import sys
import time
import signal
import subprocess
from typing import List, Dict


class ServiceManager:
    """服务管理器"""
    
    def __init__(self):
        self.processes: Dict[str, subprocess.Popen] = {}
        self.running = True
        
        # 注册信号处理
        signal.signal(signal.SIGINT, self._signal_handler)
        signal.signal(signal.SIGTERM, self._signal_handler)
    
    def _signal_handler(self, signum, frame):
        """信号处理器"""
        print(f"\n📡 接收到信号 {signum}，正在关闭服务...")
        self.running = False
        self.stop_all()
    
    def start_web_server(self):
        """启动Web服务器"""
        print("🌐 启动Web服务器...")
        cmd = [sys.executable, "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8008", "--reload"]
        process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True)
        self.processes["web"] = process
        print("✅ Web服务器已启动 (http://localhost:8008)")
    
    def start_celery_worker(self):
        """启动Celery Worker"""
        print("👷 启动Celery Worker...")
        cmd = [sys.executable, "-m", "celery", "-A", "tasks", "worker", "--loglevel=info", "--concurrency=4"]
        process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True)
        self.processes["worker"] = process
        print("✅ Celery Worker已启动")
    
    def start_celery_beat(self):
        """启动Celery Beat（定时任务调度器）"""
        print("⏰ 启动Celery Beat...")
        cmd = [sys.executable, "-m", "celery", "-A", "tasks", "beat", "--loglevel=info"]
        process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True)
        self.processes["beat"] = process
        print("✅ Celery Beat已启动")
    
    def start_flower(self):
        """启动Flower（Celery监控界面）"""
        print("🌸 启动Flower监控...")
        cmd = [sys.executable, "-m", "celery", "-A", "tasks", "flower", "--port=5555"]
        process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True)
        self.processes["flower"] = process
        print("✅ Flower监控已启动 (http://localhost:5555)")
    
    def stop_all(self):
        """停止所有服务"""
        print("🛑 正在停止所有服务...")
        for name, process in self.processes.items():
            if process.poll() is None:  # 进程还在运行
                print(f"   停止 {name}...")
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    print(f"   强制停止 {name}...")
                    process.kill()
        print("✅ 所有服务已停止")
    
    def monitor_processes(self):
        """监控进程状态"""
        while self.running:
            for name, process in list(self.processes.items()):
                if process.poll() is not None:  # 进程已退出
                    print(f"⚠️ {name} 进程已退出，返回码: {process.returncode}")
                    # 读取输出
                    output, _ = process.communicate()
                    if output:
                        print(f"   输出: {output[-500:]}")  # 只显示最后500字符
                    del self.processes[name]
            
            time.sleep(2)
    
    def show_status(self):
        """显示服务状态"""
        print("\n📊 服务状态:")
        print("-" * 50)
        for name, process in self.processes.items():
            status = "🟢 运行中" if process.poll() is None else f"🔴 已退出 ({process.returncode})"
            print(f"   {name:10} : {status}")
        print("-" * 50)


def show_help():
    """显示帮助信息"""
    print("""
Stock Monitor Agents 2026 启动脚本

用法:
    python start.py [选项]

选项:
    web         仅启动Web服务器
    worker      仅启动Celery Worker
    beat        仅启动Celery Beat
    flower      仅启动Flower监控
    all         启动所有服务（默认）
    status      显示服务状态
    stop        停止所有服务
    help        显示此帮助信息

示例:
    python start.py all          # 启动完整系统
    python start.py web          # 仅启动Web服务
    python start.py worker       # 仅启动任务队列

环境变量配置:
    LLM_BASE_URL                 # LLM API地址
    LLM_API_KEY                  # LLM API密钥
    LLM_MODEL                    # LLM模型名称
    REDIS_URL                    # Redis连接地址
    DB_HOST                      # PostgreSQL主机
    DB_PORT                      # PostgreSQL端口
    DB_NAME                      # PostgreSQL数据库名
    DB_USER                      # PostgreSQL用户名
    DB_PASSWORD                  # PostgreSQL密码
    CELERY_BROKER_URL            # Celery代理地址
    CELERY_RESULT_BACKEND        # Celery结果后端

访问地址:
    Web服务:     http://localhost:8008
    API文档:     http://localhost:8008/docs
    Flower监控:  http://localhost:5555
    健康检查:    http://localhost:8008/health
""")


def check_environment():
    """检查环境配置"""
    print("🔍 检查环境配置...")
    
    required_vars = {
        "LLM_BASE_URL": "LLM API地址",
        "LLM_API_KEY": "LLM API密钥",
        "REDIS_URL": "Redis连接地址"
    }
    
    optional_vars = {
        "DB_HOST": "PostgreSQL主机",
        "DB_PORT": "PostgreSQL端口",
        "DB_NAME": "PostgreSQL数据库名",
        "DB_USER": "PostgreSQL用户名",
        "DB_PASSWORD": "PostgreSQL密码",
        "CELERY_BROKER_URL": "Celery代理地址",
        "CELERY_RESULT_BACKEND": "Celery结果后端"
    }
    
    missing_required = []
    missing_optional = []
    
    for var, desc in required_vars.items():
        value = os.getenv(var)
        if not value:
            missing_required.append(f"  {var} ({desc})")
        else:
            print(f"  ✅ {var}: {value[:20]}...")
    
    for var, desc in optional_vars.items():
        value = os.getenv(var)
        if not value:
            missing_optional.append(f"  {var} ({desc})")
        else:
            print(f"  ✅ {var}: {value[:20]}...")
    
    if missing_required:
        print("\n❌ 缺少必需的环境变量:")
        for var in missing_required:
            print(var)
        print("\n请设置这些环境变量后重试。")
        return False
    
    if missing_optional:
        print("\n⚠️ 缺少可选的环境变量（部分功能可能不可用）:")
        for var in missing_optional:
            print(var)
    
    print("\n✅ 环境检查通过")
    return True


def main():
    """主函数"""
    if len(sys.argv) > 1:
        command = sys.argv[1]
    else:
        command = "all"
    
    if command in ["help", "-h", "--help"]:
        show_help()
        return
    
    if command == "status":
        # 这里可以实现状态检查逻辑
        print("📊 检查服务状态...")
        print("  Web服务:     http://localhost:8008/health")
        print("  Flower监控:  http://localhost:5555")
        return
    
    if command == "stop":
        # 这里可以实现停止逻辑
        print("🛑 停止服务...")
        # 可以通过PID文件或其他方式停止
        return
    
    # 检查环境
    if not check_environment():
        sys.exit(1)
    
    # 创建服务管理器
    manager = ServiceManager()
    
    try:
        # 根据命令启动相应服务
        if command == "web":
            manager.start_web_server()
        elif command == "worker":
            manager.start_celery_worker()
        elif command == "beat":
            manager.start_celery_beat()
        elif command == "flower":
            manager.start_flower()
        elif command == "all":
            manager.start_web_server()
            time.sleep(2)  # 等待Web服务启动
            manager.start_celery_worker()
            time.sleep(2)  # 等待Worker启动
            manager.start_celery_beat()
            time.sleep(2)  # 等待Beat启动
            manager.start_flower()
        else:
            print(f"❌ 未知命令: {command}")
            show_help()
            return
        
        print("\n🚀 系统启动完成！")
        print("\n📋 访问地址:")
        print("   Web服务:    http://localhost:8008")
        print("   API文档:    http://localhost:8008/docs")
        print("   健康检查:   http://localhost:8008/health")
        if command in ["all", "flower"]:
            print("   Flower监控: http://localhost:5555")
        
        print("\n按 Ctrl+C 停止服务")
        
        # 监控进程
        manager.monitor_processes()
        
    except KeyboardInterrupt:
        pass
    finally:
        manager.stop_all()


if __name__ == "__main__":
    main()
