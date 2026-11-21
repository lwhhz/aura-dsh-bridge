Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = "D:\\AI项目\\第三方dsapp\\dsh-plugin"
shell.Run "node sidecar.mjs", 0, False
