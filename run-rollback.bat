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
node "%~dp0rollback.mjs"
echo.
echo  回滚完成，现在重新启动 DSH。
echo.
pause
