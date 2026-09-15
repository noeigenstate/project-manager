using System;
using System.IO;
using System.Net;
using System.Text;
using System.Collections.Generic;
using System.Web.Script.Serialization;
using System.Runtime.InteropServices;

class Askpass {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern uint GetShortPathName(string path, StringBuilder result, uint length);
    static int Main(string[] args) {
        try {
            if (args.Length == 2 && args[0] == "--short-path") {
                var shortened = new StringBuilder(32768);
                uint length = GetShortPathName(args[1], shortened, (uint)shortened.Capacity);
                Console.OutputEncoding = new UTF8Encoding(false);
                Console.WriteLine(length > 0 && length < shortened.Capacity ? shortened.ToString() : args[1]);
                return 0;
            }
            var endpoint = new Uri(Environment.GetEnvironmentVariable("PROJECT_GRID_ASKPASS_URL"));
            if (endpoint.Scheme != "http" || endpoint.Host != "127.0.0.1") return 1;
            var serializer = new JavaScriptSerializer();
            var bytes = Encoding.UTF8.GetBytes(serializer.Serialize(new {
                connectionId = Environment.GetEnvironmentVariable("PROJECT_GRID_ASKPASS_ID"),
                prompt = String.Join(" ", args), hint = Environment.GetEnvironmentVariable("SSH_ASKPASS_PROMPT")
            }));
            var request = (HttpWebRequest)WebRequest.Create(endpoint);
            request.Proxy = null;
            request.Method = "POST";
            request.ContentType = "application/json";
            request.Headers["Authorization"] = "Bearer " + Environment.GetEnvironmentVariable("PROJECT_GRID_ASKPASS_TOKEN");
            request.Timeout = 300000;
            request.ReadWriteTimeout = 300000;
            request.ContentLength = bytes.Length;
            using (var stream = request.GetRequestStream()) stream.Write(bytes, 0, bytes.Length);
            using (var response = request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8)) {
                var result = serializer.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                if ((bool)result["canceled"]) return 1;
                Console.OutputEncoding = new UTF8Encoding(false);
                Console.WriteLine((string)result["response"]);
            }
            return 0;
        } catch { return 1; }
    }
}
