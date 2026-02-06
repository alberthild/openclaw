#!/usr/bin/env python3
"""
Vainplex Color Configuration Script for Odoo

Sets brand colors across all Odoo color parameters and creates CSS overrides
to ensure consistent theming. Handles the stubborn nature of Odoo's CSS system.
"""

import sys
import argparse
from odoo import api, SUPERUSER_ID
import odoo.tools.config as config

DEFAULT_VAINPLEX_COLORS = {
    'primary': '#DC143C',    # Crimson Red
    'secondary': '#000000',  # Black
    'accent': '#FFFFFF',     # White
    'light': '#F8F9FA',     # Light Gray
    'dark': '#343A40'       # Dark Gray
}

def set_odoo_colors(database, colors):
    """Set colors in Odoo database through all available parameters."""
    
    config.parse_config([])
    config['db_host'] = 'db'
    config['db_port'] = 5432
    config['db_user'] = 'odoo'
    config['db_password'] = 'odoo'
    
    registry = odoo.registry(database)
    
    with registry.cursor() as cr:
        env = api.Environment(cr, SUPERUSER_ID, {})
        
        # Comprehensive list of color parameters
        color_params = [
            # Standard website colors
            ('website.company_color_primary', colors['primary']),
            ('website.company_color_secondary', colors['secondary']),
            ('website.primary_color', colors['primary']),
            ('website.secondary_color', colors['secondary']),
            
            # Web interface colors
            ('web.base_color_primary', colors['primary']),
            ('web.base_color_secondary', colors['secondary']),
            
            # Theme colors
            ('theme.primary', colors['primary']),
            ('theme.secondary', colors['secondary']),
            
            # Bootstrap variables
            ('bootstrap.primary_color', colors['primary']),
            ('bootstrap.secondary_color', colors['secondary']),
            
            # SCSS variables
            ('web.scss.color_primary', colors['primary']),
            ('web.scss.color_secondary', colors['secondary']),
            ('website.scss.color_primary', colors['primary']),
            ('website.scss.color_secondary', colors['secondary']),
            
            # CSS custom properties
            ('css.color_primary', colors['primary']),
            ('css.color_secondary', colors['secondary']),
            
            # Odoo color palette
            ('color.o-color-1', colors['primary']),
            ('color.o-color-2', colors['secondary']),
            ('color.o-color-3', colors['accent']),
            ('color.o-color-4', colors['light']),
            ('color.o-color-5', colors['dark']),
            
            # Vainplex specific
            ('vainplex.color_primary', colors['primary']),
            ('vainplex.color_secondary', colors['secondary']),
        ]
        
        updated_count = 0
        created_count = 0
        
        for key, value in color_params:
            param = env['ir.config_parameter'].sudo().search([('key', '=', key)])
            if param:
                if param.value != value:
                    param.value = value
                    updated_count += 1
                    print(f"Updated {key} = {value}")
            else:
                env['ir.config_parameter'].sudo().create({
                    'key': key,
                    'value': value
                })
                created_count += 1
                print(f"Created {key} = {value}")
        
        cr.commit()
        print(f"✅ Color configuration complete: {updated_count} updated, {created_count} created")
        
        return updated_count + created_count


def create_css_override(database, colors, override_type='frontend'):
    """Create CSS override view for stubborn color issues."""
    
    registry = odoo.registry(database)
    
    with registry.cursor() as cr:
        env = api.Environment(cr, SUPERUSER_ID, {})
        
        # Remove existing override
        existing = env['ir.ui.view'].search([
            ('name', '=', f'Vainplex {override_type.title()} Colors Override')
        ])
        if existing:
            existing.unlink()
            print(f"🗑️  Removed existing {override_type} override")
        
        # Create new override CSS
        css_content = f"""
        <template id='vainplex_{override_type}_colors' inherit_id='{'website.assets_frontend' if override_type == 'frontend' else 'web.assets_backend'}'>
            <xpath expr='.' position='inside'>
                <style>
                    /* Vainplex Brand Colors - Nuclear Override */
                    :root {{
                        --o-brand-primary: {colors['primary']} !important;
                        --o-brand-secondary: {colors['secondary']} !important;
                        --o-main-color-muted: {colors['primary']} !important;
                        --o-brand-odoo: {colors['primary']} !important;
                        --bs-primary: {colors['primary']} !important;
                        --bs-secondary: {colors['secondary']} !important;
                    }}
                    
                    /* Specific element overrides */
                    .btn-primary, .bg-primary,
                    .btn-info, .bg-info,
                    [style*='#35979c'], [style*='turquoise'] {{
                        background-color: {colors['primary']} !important;
                        border-color: {colors['primary']} !important;
                        color: {colors['accent']} !important;
                    }}
                    
                    .text-primary {{
                        color: {colors['primary']} !important;
                    }}
                    
                    .o_main_navbar {{
                        background-color: {colors['primary']} !important;
                    }}
                    
                    /* Kill any remaining turquoise */
                    [class*='turquoise'], [class*='info'] {{
                        background-color: {colors['primary']} !important;
                        color: {colors['accent']} !important;
                    }}
                    
                    /* Vainplex branding */
                    .navbar-brand {{
                        color: {colors['primary']} !important;
                    }}
                </style>
            </xpath>
        </template>
        """
        
        try:
            override_view = env['ir.ui.view'].create({
                'name': f'Vainplex {override_type.title()} Colors Override',
                'type': 'qweb',
                'arch_db': css_content,
                'key': f'vainplex.{override_type}_colors_override'
            })
            cr.commit()
            print(f"✅ Created {override_type} CSS override (ID: {override_view.id})")
            return override_view.id
        except Exception as e:
            print(f"❌ Error creating CSS override: {e}")
            return None


def clear_assets(database):
    """Clear all cached assets to force regeneration."""
    
    registry = odoo.registry(database)
    
    with registry.cursor() as cr:
        env = api.Environment(cr, SUPERUSER_ID, {})
        
        # Delete all CSS/JS assets
        assets = env['ir.attachment'].search([
            ('res_model', '=', 'ir.ui.view'),
            '|', ('name', 'ilike', '%.css'), ('name', 'ilike', '%.js')
        ])
        
        if assets:
            count = len(assets)
            assets.unlink()
            print(f"🗑️  Deleted {count} cached assets")
        else:
            print("ℹ️  No cached assets found")
        
        cr.commit()
        return len(assets) if assets else 0


def main():
    parser = argparse.ArgumentParser(description='Set Vainplex brand colors in Odoo')
    parser.add_argument('--database', '-d', default='vainplex', help='Database name')
    parser.add_argument('--primary', default=DEFAULT_VAINPLEX_COLORS['primary'], help='Primary color')
    parser.add_argument('--secondary', default=DEFAULT_VAINPLEX_COLORS['secondary'], help='Secondary color')
    parser.add_argument('--accent', default=DEFAULT_VAINPLEX_COLORS['accent'], help='Accent color')
    parser.add_argument('--clear-assets', action='store_true', help='Clear cached assets')
    parser.add_argument('--css-override', choices=['frontend', 'backend', 'both'], 
                       help='Create CSS override views')
    parser.add_argument('--nuclear', action='store_true', 
                       help='Nuclear option: set colors + clear assets + CSS overrides')
    
    args = parser.parse_args()
    
    colors = {
        'primary': args.primary,
        'secondary': args.secondary,
        'accent': args.accent,
        'light': DEFAULT_VAINPLEX_COLORS['light'],
        'dark': DEFAULT_VAINPLEX_COLORS['dark']
    }
    
    print(f"🎨 Setting Vainplex colors for database: {args.database}")
    print(f"   Primary: {colors['primary']}")
    print(f"   Secondary: {colors['secondary']}")
    print(f"   Accent: {colors['accent']}")
    print()
    
    try:
        # Set color parameters
        param_count = set_odoo_colors(args.database, colors)
        
        # Clear assets if requested
        if args.clear_assets or args.nuclear:
            asset_count = clear_assets(args.database)
        
        # Create CSS overrides if requested
        if args.css_override or args.nuclear:
            override_types = ['both'] if args.nuclear else [args.css_override] if args.css_override else []
            
            for override_type in override_types:
                if override_type == 'both':
                    create_css_override(args.database, colors, 'frontend')
                    create_css_override(args.database, colors, 'backend')
                else:
                    create_css_override(args.database, colors, override_type)
        
        print(f"\n🎉 Vainplex color configuration complete!")
        print(f"   Remember to restart containers: docker-compose restart")
        
    except Exception as e:
        print(f"❌ Error: {e}")
        sys.exit(1)


if __name__ == '__main__':
    main()