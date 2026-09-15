// Offline desktop fixture. It never invokes Codex or sends model requests.
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

class RestoreCodexFixture {
    static void Main(string[] args) {
        Console.OutputEncoding = new UTF8Encoding(false);
        var receipt = new { cwd = Directory.GetCurrentDirectory(), args = args };
        File.WriteAllText(Path.Combine(Directory.GetCurrentDirectory(), "resume-receipt.json"), new JavaScriptSerializer().Serialize(receipt), new UTF8Encoding(false));
        Console.WriteLine("COPY_SAMPLE_START");
        for (int i = 0; i < 150; i++) Console.WriteLine("scrollback line " + i);
        Console.WriteLine("COPY_SAMPLE_END 中文可复制");
        Console.WriteLine("RESTORE_FIXTURE_READY");
        while (true) Thread.Sleep(1000);
    }
}
