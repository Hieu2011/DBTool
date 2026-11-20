using DbStudio.Core;

namespace DbStudio.Providers;

public sealed class ProviderRegistry
{
    private readonly Dictionary<DbKind, IDbProvider> _dicProviders;

    public ProviderRegistry(IEnumerable<IDbProvider> lstProviders) =>
        _dicProviders = lstProviders.ToDictionary(objProvider => objProvider.Kind);

    public IDbProvider Get(DbKind enmKind) =>
        _dicProviders.TryGetValue(enmKind, out var objProvider)
            ? objProvider
            : throw new NotSupportedException($"{enmKind} is not supported yet.");

    public IEnumerable<DbKind> Supported => _dicProviders.Keys;
}
