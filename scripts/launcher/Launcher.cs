using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

// Fast-only entry. Exit 75 means no application was started: start.cmd may use PowerShell.
internal static class Launcher {
  const int Retry = 75;
  static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
  static readonly StringComparison Comparison = StringComparison.OrdinalIgnoreCase;
  delegate bool ControlHandler(uint signal);
  [DllImport("kernel32.dll")] static extern bool SetConsoleCtrlHandler(ControlHandler handler, bool add);
  static readonly ControlHandler CloseHandler=OnConsoleControl;
  static Process activeChild;
  static bool OnConsoleControl(uint signal) {
    if(signal!=2 && signal!=5 && signal!=6)return false;
    // Windows also notifies Node. Keep the lifetime gate until its bounded cleanup ends.
    try{Process child=activeChild;if(child!=null)child.WaitForExit(4500);}catch(InvalidOperationException){}
    return true;
  }
  sealed class Hint {
    public string Mode, App, Home, Runtime, Node, Cache, CacheHash, State, StateHash, Marker, MarkerHash, Build, BootstrapHash, File;
  }
  static bool Same(string a, string b) { return String.Equals(a, b, Comparison); }
  static string Full(string value) {
    if (String.IsNullOrEmpty(value) || !Regex.IsMatch(value, @"^[a-zA-Z]:[\\/]")) throw new InvalidDataException("path-needs-legacy-handling");
    if (value.IndexOfAny(new char[] {'\0','\r','\n','"'}) >= 0) throw new InvalidDataException("invalid-path");
    string result = Path.GetFullPath(value).TrimEnd('\\');
    // Framework path handling is intentionally conservative. PowerShell owns other paths.
    if (result.Length < 4 || result.Length > 259) throw new InvalidDataException("path-needs-legacy-handling");
    return result;
  }
  static string Resolve(string value, string app) { return Full(Path.IsPathRooted(value) ? value : Path.Combine(app, value)); }
  static void NoLinks(string value) {
    for (string part = value; part != null; part = Path.GetDirectoryName(part)) {
      try { if ((File.GetAttributes(part) & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("linked-path"); }
      catch (FileNotFoundException) {} catch (DirectoryNotFoundException) {}
    }
  }
  static string Sha(byte[] value) { using (SHA256 digest = SHA256.Create()) return BitConverter.ToString(digest.ComputeHash(value)).Replace("-", "").ToLowerInvariant(); }
  static string FileSha(string file) { return Sha(File.ReadAllBytes(file)); }
  static string Field(BinaryReader reader) {
    int length = reader.ReadInt32();
    if (length < 0 || length > 1024 * 1024) throw new InvalidDataException("invalid-field-length");
    byte[] bytes = reader.ReadBytes(length);
    if (bytes.Length != length) throw new InvalidDataException("truncated-hint");
    return Utf8.GetString(bytes);
  }
  static string Home(string app, bool installed) {
    string requested = Environment.GetEnvironmentVariable("MEDIASCOPE_HOME");
    if (!installed) {
      string home = Resolve(String.IsNullOrEmpty(requested) ? Path.Combine(Environment.GetEnvironmentVariable("LOCALAPPDATA"), "MediaScope") : requested, app);
      if (Same(home, app)) throw new InvalidDataException("source-is-home");
      return home;
    }
    DirectoryInfo parent = Directory.GetParent(app);
    // Extracted packages and ambiguous installation choices keep the full resolver.
    if (parent == null || !Same(parent.Name, "apps") || parent.Parent == null) throw new InvalidDataException("package-entry");
    string root = Full(parent.Parent.FullName);
    if (!String.IsNullOrEmpty(requested) && !Same(Resolve(requested, app), root)) throw new InvalidDataException("installation-choice-needs-legacy");
    if (!File.Exists(Path.Combine(root, "current.json"))) throw new InvalidDataException("missing-installation");
    return root;
  }
  static Hint ReadHint(string app, string home, bool installed) {
    string key = Sha(Utf8.GetBytes(app.ToLowerInvariant()));
    string file = Path.Combine(home, "launch-cache", key + ".fast");
    NoLinks(app); NoLinks(home); NoLinks(file);
    byte[] bytes = File.ReadAllBytes(file);
    if (bytes.Length < 40 || bytes.Length > 4 * 1024 * 1024 || Encoding.ASCII.GetString(bytes, 0, 8) != "MSFAST03") throw new InvalidDataException("invalid-hint");
    byte[] checksum = new byte[32], body = new byte[bytes.Length - 40];
    Buffer.BlockCopy(bytes, 8, checksum, 0, 32); Buffer.BlockCopy(bytes, 40, body, 0, body.Length);
    if (Sha(body) != BitConverter.ToString(checksum).Replace("-", "").ToLowerInvariant()) throw new InvalidDataException("hint-checksum");
    Hint hint = new Hint();
    using (MemoryStream stream = new MemoryStream(body)) using (BinaryReader reader = new BinaryReader(stream, Utf8)) {
      hint.Mode=Field(reader); hint.App=Field(reader); hint.Home=Field(reader); hint.Runtime=Field(reader); hint.Node=Field(reader);
      hint.Cache=Field(reader); hint.CacheHash=Field(reader); hint.State=Field(reader); hint.StateHash=Field(reader); hint.Marker=Field(reader); hint.MarkerHash=Field(reader);
      hint.Build=Field(reader); hint.BootstrapHash=Field(reader);
      if (stream.Position != stream.Length) throw new InvalidDataException("extra-hint-fields");
    }
    hint.File=file;
    if (hint.Mode != (installed ? "installed" : "source") || !Same(Full(hint.App),app) || !Same(Full(hint.Home),home)) throw new InvalidDataException("hint-scope");
    if (hint.Build != LauncherBuild.Fingerprint || hint.BootstrapHash != LauncherBuild.BootstrapHash) throw new InvalidDataException("launcher-build-changed");
    string bootstrap=Path.Combine(app,"scripts","fast-bootstrap.mjs"); NoLinks(bootstrap);
    if (FileSha(bootstrap) != hint.BootstrapHash) throw new InvalidDataException("bootstrap-changed");
    if (!installed) {
      // A source edit invalidates the old compiled launcher before it can run old logic.
      using (MemoryStream input = new MemoryStream()) {
        foreach (string name in new string[] {"launcher/Launcher.cs","build-launcher.ps1","fast-bootstrap.mjs"}) {
          string source=Path.Combine(app,"scripts",name.Replace('/',Path.DirectorySeparatorChar)); NoLinks(source);
          byte[] part=File.ReadAllBytes(source); input.Write(part,0,part.Length);
        }
        if (Sha(input.ToArray()) != LauncherBuild.Fingerprint) throw new InvalidDataException("source-launcher-changed");
      }
    }
    hint.Runtime=Full(hint.Runtime); hint.Node=Full(hint.Node);
    if (!Same(Path.GetExtension(hint.Node),".exe") || !Same(Full(hint.Cache),Path.Combine(home,"launch-cache",key+".json"))) throw new InvalidDataException("record-path");
    NoLinks(hint.Runtime); NoLinks(hint.Cache); NoLinks(Path.Combine(home,"staging")); NoLinks(Path.Combine(home,"deployment.lock"));
    if (installed) {
      if (!Same(Full(hint.State),Path.Combine(home,"current.json")) || !Same(Full(hint.Marker),Path.Combine(home,"install.json"))) throw new InvalidDataException("installation-record-path");
      string runtimeOverride=Environment.GetEnvironmentVariable("MEDIASCOPE_RUNTIME_HOME");
      if (!String.IsNullOrEmpty(runtimeOverride) && !Same(Resolve(runtimeOverride,app),hint.Runtime)) throw new InvalidDataException("runtime-override");
      NoLinks(hint.State); NoLinks(hint.Marker);
      if (FileSha(hint.State)!=hint.StateHash || FileSha(hint.Marker)!=hint.MarkerHash) throw new InvalidDataException("installation-record-changed");
    } else if (hint.State!="" || hint.Marker!="" || !Same(hint.Runtime,home)) throw new InvalidDataException("source-record");
    if (FileSha(hint.Cache)!=hint.CacheHash) throw new InvalidDataException("launch-record-changed");
    return hint;
  }
  static string Quote(string value) {
    StringBuilder result=new StringBuilder("\""); int slashes=0;
    foreach (char c in value) {
      if(c=='\\'){slashes++;continue;}
      if(c=='"'){result.Append('\\',slashes*2+1);result.Append('"');slashes=0;continue;}
      result.Append('\\',slashes);slashes=0;result.Append(c);
    }
    result.Append('\\',slashes*2);result.Append('"');return result.ToString();
  }
  static void Trace(string message) { if(Environment.GetEnvironmentVariable("MEDIASCOPE_LAUNCH_TRACE")=="1")Console.WriteLine("MS_LAUNCH:"+message); }
  public static int Main(string[] arguments) {
    string app,home;bool installed;Hint hint;
    try {
      if(arguments.Length!=2 || arguments[0]!="--app")return Retry;
      app=Full(arguments[1]);installed=File.Exists(Path.Combine(app,"MANIFEST.json"));home=Home(app,installed);
      if(!Environment.Is64BitOperatingSystem || Environment.GetEnvironmentVariable("PROCESSOR_ARCHITECTURE")=="ARM64" || Environment.GetEnvironmentVariable("PROCESSOR_ARCHITEW6432")=="ARM64")return Retry;
      hint=ReadHint(app,home,installed);
    } catch(Exception error) { Trace("legacy:"+error.Message);return Retry; }
    FileStream gate;
    try { gate=new FileStream(Path.Combine(home,"deployment.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None); }
    catch(Exception error) { Console.Error.WriteLine("[MediaScope] "+error.Message);return 1; }
    using(gate) {
      try { hint=ReadHint(app,home,installed); }
      catch(Exception error) { Trace("legacy:"+error.Message);return Retry; }
      try {
        Console.CancelKeyPress += delegate(object sender,ConsoleCancelEventArgs e){e.Cancel=true;};
        SetConsoleCtrlHandler(CloseHandler,true);
        ProcessStartInfo info=new ProcessStartInfo();info.FileName=hint.Node;info.WorkingDirectory=app;info.UseShellExecute=false;
        // Match deployment.ps1 when start.cmd inherits PowerShell 7's module search path.
        info.EnvironmentVariables["PSModulePath"]=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),"System32","WindowsPowerShell","v1.0","Modules")+";"+(Environment.GetEnvironmentVariable("PSModulePath")??"");
        string staging=Path.Combine(home,"staging");NoLinks(staging);Directory.CreateDirectory(staging);
        string sequence=Guid.NewGuid().ToString("N");
        string handoff=Path.Combine(staging,"handoff-"+sequence+".tmp"),request=Path.Combine(staging,"launch-"+sequence+".json");NoLinks(handoff);NoLinks(request);
        // The handle survives a hard child exit. DeleteOnClose also cleans it on parent termination.
        using(FileStream ticket=new FileStream(handoff,FileMode.CreateNew,FileAccess.ReadWrite,FileShare.ReadWrite|FileShare.Delete,1,FileOptions.DeleteOnClose)) {
        using(FileStream configuration=new FileStream(request,FileMode.CreateNew,FileAccess.ReadWrite,FileShare.ReadWrite|FileShare.Delete,1,FileOptions.DeleteOnClose)) {
          info.Arguments=Quote(Path.Combine(app,"scripts","fast-bootstrap.mjs"))+" "+Quote(hint.File)+" "+Quote(handoff)+" "+Quote(request);
          Console.WriteLine("Using the saved runtime; automatic environment checks skipped.");Trace("fast");
          using(Process child=Process.Start(info)) {
            activeChild=child;child.WaitForExit();activeChild=null;
            // After handoff, even a hard process.exit(75) cannot start a second application.
            return child.ExitCode==Retry&&ticket.Length==0?Retry:(child.ExitCode==0?0:1);
          }
        }
        }
      } catch(Exception error) { Console.Error.WriteLine("[MediaScope] "+error.Message);return 1; }
    }
  }
}
