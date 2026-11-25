using System.Security.Cryptography;
using DbStudio.Host.Services;

namespace DbStudio.Host;

internal static class Program
{
    /// <summary>
    /// Normal run: Kestrel on 127.0.0.1:random + token, window loads the embedded UI.
    /// --dev: Kestrel on 127.0.0.1:5280 without token, window loads the Vite dev server (5173).
    /// </summary>
    [STAThread]
    private static void Main(string[] arrArgs)
    {
        var boolDev = arrArgs.Contains("--dev");

        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        var strToken = boolDev ? null : Convert.ToHexString(RandomNumberGenerator.GetBytes(24));
        var objApp = ApiHost.Build(arrArgs, boolDev, strToken);
        objApp.StartAsync().GetAwaiter().GetResult();

        try
        {
            var strUrl = boolDev ? "http://localhost:5173" : ApiHost.GetListeningAddress(objApp);
            Application.Run(new MainForm(strUrl, strToken, boolDev, objApp.Services.GetRequiredService<ExportTargets>(),
                objApp.Services.GetRequiredService<SqlFiles>(), objApp.Services.GetRequiredService<SettingsStore>(), objApp.Services.GetRequiredService<UpdateService>()));
        }
        finally
        {
            objApp.StopAsync().GetAwaiter().GetResult();
            objApp.DisposeAsync().AsTask().GetAwaiter().GetResult(); // closes open DB sessions
        }
    }
}
