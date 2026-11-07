param([Parameter(Mandatory=$true)][int]$RootPid,[ValidateSet('file','folder','cancel','inspect','command')][string]$Action,[string]$Value,[ValidateSet(1,2,6,7)][int]$Button=1,[string]$OutputPath)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
Add-Type @'
using System;using System.Text;using System.Collections.Generic;using System.Runtime.InteropServices;
public static class OwnedDialog {
 public delegate bool Callback(IntPtr w,IntPtr l);
 [DllImport("user32.dll")]static extern bool EnumWindows(Callback cb,IntPtr l);
 [DllImport("user32.dll")]static extern bool EnumChildWindows(IntPtr root,Callback cb,IntPtr l);
 [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr w);
 [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr w,out uint p);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetClassName(IntPtr w,StringBuilder s,int n);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern IntPtr SendMessage(IntPtr w,int m,IntPtr a,string b);
 [DllImport("user32.dll")]public static extern bool PostMessage(IntPtr w,int m,IntPtr a,IntPtr b);
 [DllImport("user32.dll")]public static extern IntPtr GetDlgItem(IntPtr w,int id);
 [DllImport("kernel32.dll",SetLastError=true)]static extern IntPtr OpenProcess(int rights,bool inherit,int pid);
 [DllImport("kernel32.dll",SetLastError=true)]static extern IntPtr VirtualAllocEx(IntPtr p,IntPtr address,UIntPtr size,uint allocation,uint protection);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool WriteProcessMemory(IntPtr p,IntPtr address,byte[] data,UIntPtr size,out UIntPtr written);
 [DllImport("kernel32.dll")]static extern bool VirtualFreeEx(IntPtr p,IntPtr address,UIntPtr size,uint kind);
 [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr p);
 [DllImport("user32.dll",EntryPoint="SendMessageTimeoutW",SetLastError=true)]static extern IntPtr MessageTimeout(IntPtr w,uint m,IntPtr a,IntPtr b,uint flags,uint timeout,out UIntPtr result);
 public static void Folder(IntPtr w,int pid,string path){uint actual;GetWindowThreadProcessId(w,out actual);if(actual!=pid)throw new Exception("Owned dialog PID changed");var data=Encoding.Unicode.GetBytes(path+"\0");var p=OpenProcess(0x28,false,pid);if(p==IntPtr.Zero)throw new Exception("Cannot open owned dialog process");IntPtr memory=IntPtr.Zero;try{memory=VirtualAllocEx(p,IntPtr.Zero,(UIntPtr)data.Length,0x3000,4);UIntPtr written,result;if(memory==IntPtr.Zero||!WriteProcessMemory(p,memory,data,(UIntPtr)data.Length,out written)||written.ToUInt64()!=(ulong)data.Length)throw new Exception("Cannot marshal owned folder selection");if(MessageTimeout(w,1127,(IntPtr)1,memory,2,5000,out result)==IntPtr.Zero)throw new Exception("Owned folder selection timed out");}finally{if(memory!=IntPtr.Zero)VirtualFreeEx(p,memory,UIntPtr.Zero,0x8000);CloseHandle(p);}}
 public static IntPtr FilenameEdit(IntPtr dialog){var host=GetDlgItem(dialog,1148);var result=IntPtr.Zero;var s=new StringBuilder(128);GetClassName(host,s,128);if(s.ToString()=="Edit")return host;EnumChildWindows(host,(w,l)=>{var n=new StringBuilder(128);GetClassName(w,n,128);if(n.ToString()=="Edit")result=w;return true;},IntPtr.Zero);return result;}
 public static IntPtr[] Find(int[] ids){var result=new List<IntPtr>();EnumWindows((w,l)=>{uint p;GetWindowThreadProcessId(w,out p);var s=new StringBuilder(128);GetClassName(w,s,128);if(Array.IndexOf(ids,(int)p)>=0&&IsWindowVisible(w)&&s.ToString()=="#32770")result.Add(w);return true;},IntPtr.Zero);return result.ToArray();}
}
'@
$deadline=[DateTime]::UtcNow.AddSeconds(25)
$window=[IntPtr]::Zero
do {
 $processes=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId)
 $owned=[Collections.Generic.HashSet[int]]::new();$null=$owned.Add($RootPid)
 do {$added=$false;foreach($p in $processes){if($owned.Contains([int]$p.ParentProcessId)-and $owned.Add([int]$p.ProcessId)){$added=$true}}}while($added)
 $windows=@([OwnedDialog]::Find([int[]]@($owned)))
 if($windows.Count -gt 1){throw 'TEST_INFRA: more than one owned modal dialog; refusing ambiguous input'}
 if($windows.Count -eq 1){$window=$windows[0];break}
 Start-Sleep -Milliseconds 100
}while([DateTime]::UtcNow -lt $deadline)
if($window -eq [IntPtr]::Zero){throw 'TEST_INFRA: no owned native dialog on the interactive desktop'}
$element=[Windows.Automation.AutomationElement]::FromHandle($window)
$record=@{schema=1;rootPid=$RootPid;pid=$element.Current.ProcessId;window=$window.ToInt64();title=$element.Current.Name;action=$Action;value=$Value;owned=$owned.Contains($element.Current.ProcessId)}
if(!$record.owned){throw 'TEST_INFRA: dialog ownership changed'}
if($Action -eq 'file'){
 $condition=[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Edit)
 $edits=@($element.FindAll([Windows.Automation.TreeScope]::Descendants,$condition))
 $edit=@($edits|Where-Object {$_.Current.AutomationId -in @('1148','1001') -or $_.Current.Name -match '文件名|File name'})|Select-Object -First 1
 if($edit){$pattern=$edit.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern);$pattern.SetValue($Value);$record.inputMethod='UIA ValuePattern'}
 else {
  $editHandle=[OwnedDialog]::FilenameEdit($window)
  if($editHandle -eq [IntPtr]::Zero){throw 'TEST_INFRA: owned dialog has no filename Edit under control 1148'}
  $null=[OwnedDialog]::SendMessage($editHandle,12,[IntPtr]::Zero,$Value);$record.inputMethod='owned Win32 Edit WM_SETTEXT'
 }
}elseif($Action -eq 'folder'){
 # SHBrowseForFolder BFFM_SETSELECTIONW. See Microsoft BFFCALLBACK documentation.
 # Custom WM_USER messages do not marshal pointers across processes. Allocate
 # only in the previously verified owned picker, then free after SendMessage.
 [OwnedDialog]::Folder($window,$element.Current.ProcessId,$Value)
 Start-Sleep -Milliseconds 150
}
if($Action -ne 'inspect'){
 $id=if($Action -eq 'cancel'){2}elseif($Action -eq 'command'){$Button}else{1}
 $commandHandle=[OwnedDialog]::GetDlgItem($window,$id)
 if($commandHandle -eq [IntPtr]::Zero){throw 'TEST_INFRA: owned dialog has no expected command button'}
 $null=[OwnedDialog]::PostMessage($commandHandle,245,[IntPtr]::Zero,[IntPtr]::Zero)
}
$encoded=$record|ConvertTo-Json -Depth 8
if($OutputPath){[IO.File]::WriteAllText($OutputPath,$encoded,[Text.UTF8Encoding]::new($false))}
$encoded
