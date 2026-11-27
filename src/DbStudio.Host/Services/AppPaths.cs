namespace DbStudio.Host.Services;

internal static class AppPaths
{
    /// <summary>Where connections, settings, history... are kept: %APPDATA%\DbStudio. DBSTUDIO_DATA_DIR points a test run
    /// at a folder of its own, so it never touches the user's saved connections.</summary>
    public static string DataDirectory { get; } =
        Environment.GetEnvironmentVariable("DBSTUDIO_DATA_DIR") is { Length: > 0 } strOverride
            ? Path.GetFullPath(strOverride)
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "DbStudio");
}
