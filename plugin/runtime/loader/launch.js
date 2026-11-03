// shar8-loader: 1
// JScript for wscript //B. ASCII only, no paths inside. Args: <node.exe> <shim.mjs> tick
var sh = new ActiveXObject("WScript.Shell");
var fso = new ActiveXObject("Scripting.FileSystemObject");
var args = WScript.Arguments;
var node = args.length > 0 ? args(0) : "";
var shim = args.length > 1 ? args(1) : "";
var rest = "";
for (var i = 2; i < args.length; i++) { rest += " " + args(i); }
function hb(state, code) {
  try {
    var dir = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "state");
    if (!fso.FolderExists(dir)) { fso.CreateFolder(dir); }
    var d = new Date();
    var at = d.getUTCFullYear() + "-" + ("0" + (d.getUTCMonth() + 1)).slice(-2) + "-" + ("0" + d.getUTCDate()).slice(-2) +
      "T" + ("0" + d.getUTCHours()).slice(-2) + ":" + ("0" + d.getUTCMinutes()).slice(-2) + ":" + ("0" + d.getUTCSeconds()).slice(-2) + "Z";
    var tmp = fso.BuildPath(dir, "heartbeat.json.tmp");
    var f = fso.CreateTextFile(tmp, true);
    f.Write('{"v":1,"at":"' + at + '","phase":"done","state":"' + state + '","exit":' + code + '}');
    f.Close();
    var dst = fso.BuildPath(dir, "heartbeat.json");
    if (fso.FileExists(dst)) { fso.DeleteFile(dst, true); }
    fso.MoveFile(tmp, dst);
  } catch (e) { }
}
function run(file) { return sh.Run('"' + node + '" "' + file + '"' + rest, 0, true); }
if (!node || !fso.FileExists(node)) { hb("node_missing", 78); WScript.Quit(78); }
var rc = run(shim);
if (rc === 0 || rc === 77 || rc === 78) { WScript.Quit(rc); }
var prev = shim.replace(/shim\.mjs$/i, "shim.prev.mjs");
if (prev !== shim && fso.FileExists(prev)) { hb("shim_broken", 78); WScript.Quit(run(prev)); }
hb("shim_broken", 78);
WScript.Quit(78);
