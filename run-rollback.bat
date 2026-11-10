@echo off
chcp 65001 >nul
echo.
echo  ============================================
echo   DSH Growth Workbench - 一键回滚
echo  ============================================
echo.
echo  如果装完插件后 DSH 起不来，双击这个文件。
echo  它不依赖 DSH 运行，直接用 node 改配置文件。
echo.
pause
rem 同一个 Node 进程展示并确认原计划；不在第二次调用中重新规划。
node "%~dp0rollback.mjs" --confirm %*
if errorlevel 1 goto failed
echo.
echo  回滚完成。备份路径见上方；需要时请自行重新启动 DSH。
goto end
:failed
echo.
echo  回滚没有完成，请检查上方错误。不要把失败当成已回滚。
:end
echo.
pause
