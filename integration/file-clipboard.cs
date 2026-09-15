using System;
using System.IO;
using System.Text;
using System.Collections;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.Windows.Forms;
using System.Web.Script.Serialization;

class FileClipboard {
    [STAThread]
    static int Main() {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        var json = new JavaScriptSerializer();
        try {
            var input = json.Deserialize<Dictionary<string, object>>(Console.In.ReadToEnd());
            if ((string)input["action"] == "read") {
                var paths = new List<string>();
                foreach (string entry in Clipboard.GetFileDropList()) paths.Add(entry);
                Console.WriteLine(json.Serialize(paths));
            } else if ((string)input["action"] == "move") {
                var paths = new List<string>();
                foreach (object entry in (IEnumerable)input["paths"]) paths.Add(Path.GetFullPath((string)entry));
                if (paths.Count != 2) throw new IOException("无效的文件移动操作。 ");
                // .NET's Move uses the non-overwriting Windows operation.
                if (Directory.Exists(paths[0])) Directory.Move(paths[0], paths[1]);
                else File.Move(paths[0], paths[1]);
                Console.WriteLine("true");
            } else if ((string)input["action"] == "copy") {
                var paths = new List<string>();
                foreach (object entry in (IEnumerable)input["paths"]) {
                    string filename = Path.GetFullPath((string)entry);
                    if (!File.Exists(filename) && !Directory.Exists(filename)) throw new IOException("文件已不存在。 ");
                    paths.Add(filename);
                }
                if (paths.Count == 0) throw new IOException("请选择文件。 ");
                var data = new DataObject();
                data.SetData(DataFormats.FileDrop, paths.ToArray());
                data.SetData(DataFormats.UnicodeText, String.Join("\r\n", paths));
                data.SetData("Preferred DropEffect", new MemoryStream(new byte[] { 1, 0, 0, 0 }));
                Clipboard.SetDataObject(data, true, 5, 60);
                Console.WriteLine("true");
            } else throw new IOException("不支持的剪贴板操作。 ");
            return 0;
        } catch (Exception error) {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }
}
