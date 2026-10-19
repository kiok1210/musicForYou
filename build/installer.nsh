; 自定义卸载行为。
;
; electron-builder 默认会生成卸载程序（安装目录里的 Uninstall VinylBox.exe，
; 同时注册到「程序和功能」），但它**故意不删** %APPDATA%\VinylBox。
; 那个目录在本项目实测有 1.7GB 以上，其中缓存的歌曲就占 1.1GB ——
; 默认删掉等于把用户几小时的下载成果一起抹了，所以保留是对的。
;
; 但想彻底清干净的人也需要入口，于是卸载时问一句：
;   「是」→ 连数据一起删，重装如同全新
;   「否」→ 保留数据，重装后还能继续听
;
; ${isUpdated} 判断是覆盖升级：升级时旧版会被静默卸载，
; 这时候弹窗纯属打扰，必须跳过。静默卸载（/S）下 MessageBox 也会被系统忽略，
; 行为自然退化成「保留数据」，安全。

!macro customUnInstall
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION \
      "是否同时删除缓存的歌曲、下载的核心组件与登录信息？$\r$\n$\r$\n\
      选「是」：彻底清净，重新安装后如同全新。$\r$\n\
      选「否」：保留这些数据（约 1-2 GB），重装后还能继续听。" \
      IDNO VinylBoxKeepUserData
    RMDir /r "$APPDATA\VinylBox"
    DetailPrint "VinylBox: user data removed"
    VinylBoxKeepUserData:
  ${endIf}
!macroend
