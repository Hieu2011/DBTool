using System.Net;
using System.Text.Json.Serialization;
using DbStudio.Core;
using DbStudio.Host.Api;
using DbStudio.Host.Services;
using DbStudio.Providers;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.FileProviders;

namespace DbStudio.Host;

internal static class ApiHost
{
    public const string TokenHeader = "X-DbStudio-Token";
    public const int DevPort = 5280;

    public static WebApplication Build(string[] arrArgs, bool boolDev, string? strToken)
    {
        var objBuilder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            Args = arrArgs,
            ContentRootPath = AppContext.BaseDirectory,
        });

        // Loopback only: nothing outside this PC can reach the API.
        objBuilder.WebHost.UseKestrel(objOptions => objOptions.Listen(IPAddress.Loopback, boolDev ? DevPort : 0));
        objBuilder.Logging.SetMinimumLevel(boolDev ? LogLevel.Information : LogLevel.Warning);

        objBuilder.Services.ConfigureHttpJsonOptions(objOptions =>
            objOptions.SerializerOptions.Converters.Add(new JsonStringEnumConverter()));

        objBuilder.Services.AddSingleton<IConnectionStore, DpapiConnectionStore>();
        objBuilder.Services.AddSingleton<IDbProvider, PostgresProvider>();
        objBuilder.Services.AddSingleton<IDbProvider, OracleProvider>();
        objBuilder.Services.AddSingleton<IDbProvider, MongoProvider>();
        // Also by its own type: the key browser endpoints call it directly.
        objBuilder.Services.AddSingleton<RedisProvider>();
        objBuilder.Services.AddSingleton<IDbProvider>(objServices => objServices.GetRequiredService<RedisProvider>());
        objBuilder.Services.AddSingleton<ProviderRegistry>();
        objBuilder.Services.AddSingleton<MetadataCache>();
        objBuilder.Services.AddSingleton<QueryRegistry>();
        objBuilder.Services.AddSingleton<SessionRegistry>();
        objBuilder.Services.AddSingleton<DiagramLayoutStore>();
        objBuilder.Services.AddSingleton<ExportTargets>();
        objBuilder.Services.AddSingleton<SqlFiles>();
        objBuilder.Services.AddSingleton<SettingsStore>();
        objBuilder.Services.AddSingleton<HistoryStore>();
        objBuilder.Services.AddSingleton<SnippetStore>();
        objBuilder.Services.AddSingleton<WorkspaceStore>();
        objBuilder.Services.AddSingleton<UpdateService>();

        var objApp = objBuilder.Build();

        // Every /api call must carry the per-launch token, so other local processes
        // and web pages can't use the API. Disabled in --dev so a normal browser works.
        if (strToken is not null)
        {
            objApp.Use(async (objContext, fnNext) =>
            {
                if (objContext.Request.Path.StartsWithSegments("/api") &&
                    objContext.Request.Headers[TokenHeader] != strToken)
                {
                    objContext.Response.StatusCode = StatusCodes.Status401Unauthorized;
                    return;
                }
                await fnNext();
            });
        }

        var objFiles = OpenEmbeddedUi();
        objApp.UseDefaultFiles(new DefaultFilesOptions { FileProvider = objFiles });
        objApp.UseStaticFiles(new StaticFileOptions { FileProvider = objFiles });

        objApp.MapDbStudioApi();
        if (objFiles.GetFileInfo("index.html").Exists)
            objApp.MapFallbackToFile("index.html", new StaticFileOptions { FileProvider = objFiles });
        else
            objApp.MapFallback(() => Results.Content(MissingUiHtml, "text/html"));

        return objApp;
    }

    /// <summary>wwwroot is filled by `npm run build` in web/. A fresh clone has none yet.</summary>
    private static IFileProvider OpenEmbeddedUi()
    {
        try { return new ManifestEmbeddedFileProvider(typeof(ApiHost).Assembly, "wwwroot"); }
        catch (InvalidOperationException) { return new NullFileProvider(); }
    }

    private const string MissingUiHtml = """
        <!doctype html><meta charset="utf-8"><title>DbStudio</title>
        <body style="font-family:Segoe UI,sans-serif;padding:2rem">
        <p>The UI is not built into this exe. Run <code>npm run build</code> in <code>web/</code>, then rebuild the host,
        or start with <code>--dev</code> while <code>npm run dev</code> is running.</p>
        """;

    public static string GetListeningAddress(WebApplication objApp) =>
        objApp.Services.GetRequiredService<IServer>().Features
            .Get<IServerAddressesFeature>()!.Addresses.First();
}
