using DbStudio.Host.Services;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace DbStudio.Host;

internal sealed class MainForm : Form
{
    private readonly WebView2 _objWeb = new() { Dock = DockStyle.Fill };

    public MainForm(string strUrl, string? strToken, bool boolDev, ExportTargets objExportTargets, SqlFiles objSqlFiles,
        SettingsStore objSettings, UpdateService objUpdates)
    {
        objUpdates.Attach(this);
        objExportTargets.Attach(this);
        objSqlFiles.Attach(this);
        Text = boolDev ? "DbStudio (dev)" : "DbStudio";
        Width = 1440;
        Height = 900;
        StartPosition = FormStartPosition.CenterScreen;
        // The exe's own icon (ApplicationIcon); the default one stays if it cannot be read.
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch (Exception) { }
        RestorePlacement(objSettings.Window);
        FormClosing += (_, _) =>
        {
            // Minimized or maximized: RestoreBounds is the normal window.
            var objBounds = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            objSettings.Window = new WindowPlacement(objBounds.X, objBounds.Y, objBounds.Width, objBounds.Height,
                WindowState == FormWindowState.Maximized);
        };
        Controls.Add(_objWeb);

        Load += async (_, _) =>
        {
            try
            {
                // Keep the browser profile out of the exe folder (it may be read-only).
                var strDataDir = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DbStudio", "WebView2");
                var objEnv = await CoreWebView2Environment.CreateAsync(null, strDataDir);
                await _objWeb.EnsureCoreWebView2Async(objEnv);
            }
            catch (WebView2RuntimeNotFoundException)
            {
                MessageBox.Show(
                    "Microsoft Edge WebView2 Runtime is missing.\nInstall it from https://go.microsoft.com/fwlink/p/?LinkId=2124703",
                    "DbStudio", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
                return;
            }

            var objCore = _objWeb.CoreWebView2;
            objCore.Settings.IsStatusBarEnabled = false;
            objCore.Settings.AreDevToolsEnabled = boolDev;
            objCore.Settings.AreDefaultContextMenusEnabled = boolDev;
            // Frees Ctrl+R, Ctrl+P, F5... for the app itself. Ctrl+C/V/Z still work.
            objCore.Settings.AreBrowserAcceleratorKeysEnabled = boolDev;
            objCore.NewWindowRequested += (_, objArgs) => objArgs.Handled = true;
            objCore.DocumentTitleChanged += (_, _) => Text = objCore.DocumentTitle;
            // File > Exit in the UI calls window.close().
            objCore.WindowCloseRequested += (_, _) => Close();

            // Files the UI builds itself (grid export, diagram picture): ask where to save instead of dropping them in Downloads.
            objCore.DownloadStarting += (_, objArgs) =>
            {
                var objDeferral = objArgs.GetDeferral();
                objArgs.Handled = true; // no browser download bubble
                // The dialog is modal: it must not run inside the WebView2 event itself.
                BeginInvoke(() =>
                {
                    try
                    {
                        var strExtension = Path.GetExtension(objArgs.ResultFilePath);
                        using var objDialog = new SaveFileDialog
                        {
                            Title = "Save file",
                            FileName = Path.GetFileName(objArgs.ResultFilePath),
                            InitialDirectory = Path.GetDirectoryName(objArgs.ResultFilePath),
                            Filter = strExtension.Length > 1 ? $"{strExtension[1..].ToUpperInvariant()} file|*{strExtension}|All files|*.*" : "All files|*.*",
                            DefaultExt = strExtension.TrimStart('.'),
                            AddExtension = true,
                            OverwritePrompt = true,
                        };
                        if (objDialog.ShowDialog(this) == DialogResult.OK) objArgs.ResultFilePath = objDialog.FileName;
                        else objArgs.Cancel = true;
                    }
                    finally
                    {
                        objDeferral.Complete();
                    }
                });
            };

            if (strToken is not null)
                await objCore.AddScriptToExecuteOnDocumentCreatedAsync($"window.__DBSTUDIO_TOKEN__ = '{strToken}';");

            _objWeb.Source = new Uri(strUrl);
        };
    }

    /// <summary>Puts the window back where it was closed, unless that place is no longer on a screen.</summary>
    private void RestorePlacement(WindowPlacement? objPlacement)
    {
        if (objPlacement is null || objPlacement.Width < 400 || objPlacement.Height < 300) return;
        var objBounds = new Rectangle(objPlacement.X, objPlacement.Y, objPlacement.Width, objPlacement.Height);
        // Enough of the title bar must be reachable (a monitor may have been unplugged).
        var objTitle = new Rectangle(objBounds.X, objBounds.Y, objBounds.Width, 40);
        var boolVisible = Screen.AllScreens.Any(objScreen =>
        {
            var objShown = Rectangle.Intersect(objScreen.WorkingArea, objTitle);
            return objShown.Width >= 120 && objShown.Height >= 20;
        });
        if (!boolVisible) return;

        StartPosition = FormStartPosition.Manual;
        Bounds = objBounds;
        if (objPlacement.Maximized) WindowState = FormWindowState.Maximized;
    }
}
