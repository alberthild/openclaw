# Vainplex Odoo Modules Reference

## Module Overview

### vainplex_odoo_base (Working Module)

- **Status**: ✅ Installed and functional
- **Path**: `/mnt/extra-addons/vainplex_odoo_base/`
- **Purpose**: Core Vainplex branding and customizations
- **Key Features**:
  - Typography settings
  - Layout customizations
  - Basic theme structure

**Important**: This module contains NO color definitions by default - colors must be configured separately.

### vainplex-odoo-base (Problematic Module)

- **Status**: ❌ Broken/Conflicting
- **Issue**: Hyphen in name causes module loading conflicts
- **Resolution**: Always deactivate/remove this module
- **Common Error**: "Some modules have inconsistent states, some dependencies may be missing"

## Module Management Commands

### Safe Module Operations

```bash
# Check module status
docker-compose exec web python3 -c "
from odoo import registry, api, SUPERUSER_ID
reg = registry('vainplex')
with reg.cursor() as cr:
    env = api.Environment(cr, SUPERUSER_ID, {})
    module = env['ir.module.module'].search([('name', '=', 'module_name')])
    print(f'Status: {module.state}')
"

# Safely uninstall module
docker-compose exec web odoo -d vainplex -u module_name --stop-after-init

# Install module
docker-compose exec web odoo -d vainplex -i module_name --stop-after-init
```

### Module Conflict Resolution

```python
# Disable conflicting module
broken_module = env['ir.module.module'].search([('name', '=', 'vainplex-odoo-base')])
if broken_module:
    broken_module.write({'state': 'uninstalled'})
```

## Vainplex Theme Configuration

### Color Management

The vainplex_odoo_base module does NOT handle colors. Colors must be configured through:

1. **System parameters** (ir.config_parameter)
2. **CSS overrides** (custom views)
3. **Theme settings** (website configuration)

### Required Color Parameters

```python
color_params = [
    ('website.company_color_primary', '#DC143C'),
    ('website.company_color_secondary', '#000000'),
    ('vainplex.color_primary', '#DC143C'),
    ('vainplex.color_secondary', '#000000'),
    # ... (see set_vainplex_colors.py for complete list)
]
```

### CSS Override Template

```xml
<template id='vainplex_colors_override' inherit_id='website.assets_frontend'>
    <xpath expr='.' position='inside'>
        <style>
            :root {
                --o-brand-primary: #DC143C !important;
                --o-brand-secondary: #000000 !important;
            }
            .btn-primary { background-color: #DC143C !important; }
            /* Additional overrides as needed */
        </style>
    </xpath>
</template>
```

## Module Development Guidelines

### Naming Conventions

- ✅ Use underscores: `vainplex_odoo_base`
- ❌ Avoid hyphens: `vainplex-odoo-base`
- Follow Odoo naming standards

### Manifest Structure

```python
{
    'name': 'Vainplex Odoo Base',
    'version': '16.0.1.0.0',
    'category': 'Theme',
    'summary': 'Vainplex base customizations',
    'author': 'Vainplex GmbH',
    'depends': ['base', 'web', 'website'],
    'data': [
        'views/assets.xml',
        'views/layouts.xml',
    ],
    'assets': {
        'web.assets_backend': [
            'vainplex_odoo_base/static/src/css/backend.css',
        ],
        'website.assets_frontend': [
            'vainplex_odoo_base/static/src/css/frontend.css',
        ],
    },
    'installable': True,
    'auto_install': False,
    'license': 'LGPL-3',
}
```

### Asset Management

- CSS files should be minimal and semantic
- Avoid hardcoded colors in CSS files
- Use CSS custom properties for theming
- Keep assets organized by frontend/backend

## Version Compatibility

### Odoo 16.0 (Current)

- vainplex_odoo_base: Compatible
- Asset system: Uses new asset bundles
- Color system: Requires manual parameter setting

### Upgrade Considerations

When upgrading Odoo versions:

1. Update manifest version numbers
2. Check asset bundle compatibility
3. Test color configuration methods
4. Verify CSS override inheritance

## Common Issues

### Module Won't Load

**Symptom**: Module shows as "to install" but never installs
**Causes**:

- Missing dependencies
- Syntax errors in manifest
- File permission issues

**Resolution**:

```bash
# Check logs
docker-compose logs web | grep -i error

# Verify file permissions
docker-compose exec web find /mnt/extra-addons -name "*.py" -type f -exec chmod 644 {} \;
```

### CSS Not Applied

**Symptom**: Theme changes don't appear
**Causes**:

- Asset cache not cleared
- CSS specificity issues
- Browser caching

**Resolution**:

1. Clear Odoo assets: `scripts/clear_assets.py --nuclear`
2. Restart containers: `docker-compose restart`
3. Clear browser cache: Ctrl+F5

### Color Override Conflicts

**Symptom**: Some elements stay turquoise despite configuration
**Causes**:

- Multiple CSS rules competing
- Bootstrap variable not overridden
- Asset loading order issues

**Resolution**:

1. Use CSS `!important` declarations
2. Create specific element selectors
3. Apply nuclear CSS override approach

## Module Testing Checklist

Before deploying module changes:

- [ ] Module loads without errors
- [ ] No console JavaScript errors
- [ ] Colors display correctly
- [ ] Both frontend and backend tested
- [ ] Mobile responsive design works
- [ ] Print styles appropriate (if applicable)

## Backup Procedures

Before module changes:

```bash
# Backup module directory
tar -czf vainplex_modules_backup_$(date +%Y%m%d).tar.gz /mnt/extra-addons/vainplex_*

# Backup database
docker-compose exec db pg_dump -U odoo vainplex > vainplex_backup_$(date +%Y%m%d).sql
```

## Development Workflow

1. **Development**: Work on local copy
2. **Testing**: Test in development container
3. **Staging**: Deploy to staging environment
4. **Validation**: User acceptance testing
5. **Production**: Deploy with rollback plan
