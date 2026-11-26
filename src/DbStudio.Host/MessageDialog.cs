using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace DbStudio.Host;

/// <summary>confirm() / alert() of the UI, in the app's own colours (light or dark, like the page).</summary>
internal sealed class MessageDialog : Form
{
    private readonly bool _boolDark = IsDark();

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr ptrWindow, int intAttribute, ref int intValue, int intSize);

    /// <summary>True when the user accepted (alert: always closes with true or false, nobody reads it).</summary>
    public static bool Show(IWin32Window objOwner, string strMessage, bool boolConfirm)
    {
        using var objDialog = new MessageDialog(strMessage, boolConfirm);
        return objDialog.ShowDialog(objOwner) == DialogResult.OK;
    }

    private MessageDialog(string strMessage, bool boolConfirm)
    {
        // Same tokens as web/src/index.css.
        var objPanel = Hex(_boolDark ? 0x161B22 : 0xFBFCFD);
        var objFooter = Hex(_boolDark ? 0x0F1318 : 0xEEF1F5);
        var objBorder = Hex(_boolDark ? 0x29313C : 0xD9DFE7);
        var objText = Hex(_boolDark ? 0xD8DEE7 : 0x1C232E);
        var objAccent = Hex(_boolDark ? 0x4C8FD6 : 0x1F5FA8);
        var objAccentHover = Hex(_boolDark ? 0x6AA5E3 : 0x2A70BF);
        var objOnAccent = Hex(_boolDark ? 0x0F1318 : 0xFFFFFF);
        var objHover = Hex(_boolDark ? 0x222A35 : 0xE3E8EF);

        Text = "DbStudio";
        Font = new Font("Segoe UI", 10F);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        ShowIcon = false;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.CenterParent;
        AutoScaleMode = AutoScaleMode.None; // sizes below are scaled by hand
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        BackColor = objPanel;
        ForeColor = objText;

        var objLabel = new Label
        {
            Text = strMessage,
            UseMnemonic = false,
            AutoSize = true,
            MinimumSize = new Size(Px(340), 0),
            MaximumSize = new Size(Px(560), 0),
            Margin = new Padding(Px(22), Px(20), Px(22), Px(22)),
        };

        Button MakeButton(string strText, bool boolPrimary, DialogResult enmResult)
        {
            var objButton = new Button
            {
                Text = strText,
                DialogResult = enmResult,
                Size = new Size(Px(96), Px(32)),
                Margin = new Padding(Px(8), 0, 0, 0),
                FlatStyle = FlatStyle.Flat,
                UseVisualStyleBackColor = false,
                BackColor = boolPrimary ? objAccent : objPanel,
                ForeColor = boolPrimary ? objOnAccent : objText,
                Cursor = Cursors.Hand,
            };
            objButton.FlatAppearance.BorderColor = boolPrimary ? objAccent : objBorder;
            objButton.FlatAppearance.MouseOverBackColor = boolPrimary ? objAccentHover : objHover;
            objButton.FlatAppearance.MouseDownBackColor = boolPrimary ? objAccent : objBorder;
            return objButton;
        }

        var objOk = MakeButton("OK", true, DialogResult.OK);
        var objButtons = new FlowLayoutPanel
        {
            FlowDirection = FlowDirection.RightToLeft, // first one added sits at the right edge
            WrapContents = false,
            AutoSize = true,
            Dock = DockStyle.Fill,
            Margin = Padding.Empty,
            Padding = new Padding(Px(14), Px(11), Px(14), Px(11)),
            BackColor = objFooter,
        };
        if (boolConfirm)
        {
            var objCancel = MakeButton("Cancel", false, DialogResult.Cancel);
            objButtons.Controls.Add(objCancel);
            CancelButton = objCancel;
        }
        else CancelButton = objOk; // Esc closes an alert
        objButtons.Controls.Add(objOk);
        AcceptButton = objOk;

        var objLayout = new TableLayoutPanel
        {
            ColumnCount = 1,
            RowCount = 3,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            Margin = Padding.Empty,
        };
        objLayout.Controls.Add(objLabel, 0, 0);
        objLayout.Controls.Add(new Panel { Height = 1, Dock = DockStyle.Fill, Margin = Padding.Empty, BackColor = objBorder }, 0, 1);
        objLayout.Controls.Add(objButtons, 0, 2);
        Controls.Add(objLayout);
        ActiveControl = objOk;
    }

    protected override void OnHandleCreated(EventArgs objArgs)
    {
        base.OnHandleCreated(objArgs);
        if (!_boolDark) return;
        // DWMWA_USE_IMMERSIVE_DARK_MODE: dark title bar. Older Windows ignores it.
        var intOn = 1;
        try { _ = DwmSetWindowAttribute(Handle, 20, ref intOn, sizeof(int)); } catch (Exception) { }
    }

    private int Px(int intPixels) => intPixels * DeviceDpi / 96;

    private static Color Hex(int intRgb) => Color.FromArgb(0xFF << 24 | intRgb);

    /// <summary>The Windows app theme: what prefers-color-scheme follows in the page.</summary>
    private static bool IsDark()
    {
        try
        {
            using var objKey = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            return objKey?.GetValue("AppsUseLightTheme") is int intLight && intLight == 0;
        }
        catch (Exception)
        {
            return false;
        }
    }
}
