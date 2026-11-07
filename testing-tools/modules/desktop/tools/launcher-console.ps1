param([string]$Executable,[string]$App,[string]$Log)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class TestConsole {
  delegate bool Handler(uint signal);
  static readonly Handler IgnoreSignal=delegate(uint signal){return true;};
  [StructLayout(LayoutKind.Sequential)] struct Security {public int size;public IntPtr descriptor;public int inherit;}
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup {
    public int size;public string reserved,desktop,title;public int x,y,width,height,cols,rows,fill,flags;public short show,reservedSize;public IntPtr reservedBytes,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {public IntPtr process,thread;public int pid,tid;}
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref Startup startup,out ProcessInfo info);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFile(string file,uint access,uint share,ref Security security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AttachConsole(int pid);
  [DllImport("kernel32.dll")] static extern bool FreeConsole();
  [DllImport("kernel32.dll")] static extern bool SetConsoleCtrlHandler(IntPtr handler,bool add);
  [DllImport("kernel32.dll",EntryPoint="SetConsoleCtrlHandler")] static extern bool SetControlHandler(Handler handler,bool add);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GenerateConsoleCtrlEvent(uint signal,uint group);
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll",SetLastError=true)] static extern bool PostMessage(IntPtr window,uint message,IntPtr w,IntPtr l);
  static string Quote(string value){return "\""+value.Replace("\"","\\\"")+"\"";}
  public static int Start(string exe,string app,string log){
    Security security=new Security();security.size=Marshal.SizeOf(security);security.inherit=1;
    IntPtr output=CreateFile(log,0x40000000,3,ref security,2,0,IntPtr.Zero),input=CreateFile("NUL",0x80000000,3,ref security,3,0,IntPtr.Zero);
    if(output==new IntPtr(-1)||input==new IntPtr(-1))throw new Win32Exception();
    try{Startup startup=new Startup();startup.size=Marshal.SizeOf(startup);startup.flags=0x101;startup.show=0;startup.input=input;startup.output=output;startup.error=output;
      ProcessInfo info;if(!CreateProcess(exe,new StringBuilder(Quote(exe)+" --app "+Quote(app)),IntPtr.Zero,IntPtr.Zero,true,0x10,IntPtr.Zero,app,ref startup,out info))throw new Win32Exception();
      CloseHandle(info.thread);CloseHandle(info.process);return info.pid;
    }finally{CloseHandle(input);CloseHandle(output);}
  }
  public static void Signal(int pid,string signal){
    FreeConsole();if(!AttachConsole(pid))throw new Win32Exception();
    try{SetControlHandler(IgnoreSignal,true);
      if(signal=="CLOSE"){IntPtr window=GetConsoleWindow();FreeConsole();if(window==IntPtr.Zero||!PostMessage(window,0x10,IntPtr.Zero,IntPtr.Zero))throw new Win32Exception();}
      else if(!GenerateConsoleCtrlEvent(signal=="BREAK"?1u:0u,0))throw new Win32Exception();
      System.Threading.Thread.Sleep(200);
    }finally{FreeConsole();}
  }
}
'@
$childId=[TestConsole]::Start($Executable,$App,$Log)
[Console]::WriteLine('CHILD:'+$childId)
try{
  $signal=[Console]::ReadLine()
  if($signal -notin @('INT','BREAK','CLOSE')){throw 'Unexpected test control signal'}
  $child=[Diagnostics.Process]::GetProcessById($childId)
  $child.Handle | Out-Null
  [TestConsole]::Signal($childId,$signal)
  if(!$child.WaitForExit(20000)){throw 'Console child did not exit'}
  [Console]::WriteLine('CONTROL_EXIT:'+$child.ExitCode)
}catch{
  $failure=$_
  # Only this helper's own process tree may be terminated after a failed test.
  $ErrorActionPreference='Continue'
  if(Get-Process -Id $childId -ErrorAction SilentlyContinue){& taskkill.exe /PID $childId /T /F 2>$null | Out-Null}
  throw $failure
}
