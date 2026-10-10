"""Build static marketing/blog pages and merge translations into existing i18n dictionaries.
Run from relay root: python3 scripts/build-marketing-site.py
"""
from pathlib import Path
import json,re,html
P=Path('public'); C=Path('scripts/site-content'); langs=['pt-BR','en','es','fr','ar']
articles=json.loads((C/'articles.json').read_text()); ui=json.loads((C/'ui.json').read_text()); reviews=json.loads((C/'reviews.json').read_text())
translations={l:{} for l in langs}
for k,values in ui.items():
 for l,v in zip(langs,values):translations[l][k]=v
for a in articles:
 for l in langs:
  for suffix,v in zip(['title','intro','p1','p2','p3'],a[l]):translations[l]['blog.'+a['slug']+'.'+suffix]=v
for i,(_,_,values) in enumerate(reviews,3):
 for l,v in zip(langs,values):translations[l]['site.review.'+str(i)]=v
for l in langs[1:]:
 f=P/'js/i18n'/f'{l}.js';s=f.read_text()
 for k,v in translations[l].items():
  line='  '+json.dumps(k)+': '+json.dumps(v,ensure_ascii=False)+','
  pat=r'^  [\'\"]'+re.escape(k)+r'[\'\"]:.*$'
  s=re.sub(pat,lambda m:line,s,flags=re.M) if re.search(pat,s,re.M) else s.replace('\n});','\n'+line+'\n});')
 f.write_text(s)
def t(k,tag='span',extra=''):
 return f'<{tag} data-i18n="{k}" {extra}>{html.escape(translations["pt-BR"].get(k,k))}</{tag}>'
def old(k,text,tag='span',extra=''):return f'<{tag} data-i18n="{k}" {extra}>{text}</{tag}>'
def link(k,url,cls=''):return t(k,'a',f'href="{url}" class="{cls}"')
bootstrap=re.search(r'  <script>\n    // i18n:.*?</script>',(P/'chat/index.html').read_text(),re.S).group()
def head(title,key,path,desc='',desc_key='',img='/og-image.png'):
 alts=''.join(f'<link rel="alternate" hreflang="{l}" href="https://crypto-chat.rapport.tec.br{path}?lang={l}"/>' for l in langs)
 return f'''<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>{bootstrap}
<title data-i18n="{key}">{html.escape(title)}</title><meta name="description" content="{html.escape(desc,quote=True)}" data-i18n-attr="content:{desc_key}"/>
<link rel="canonical" href="https://crypto-chat.rapport.tec.br{path}"/>{alts}<link rel="icon" href="/favicon.png"/><meta name="theme-color" content="#ed5919"/><meta name="base:app_id" content="6aa172c842c4b455d97a3d60"/><meta name="twitter:card" content="summary_large_image"/>
<meta property="og:title" content="{html.escape(title,quote=True)}" data-i18n-attr="content:{key}"/><meta property="og:description" content="{html.escape(desc,quote=True)}" data-i18n-attr="content:{desc_key}"/><meta property="og:locale" content="pt_BR"/><meta property="og:type" content="{'article' if path.startswith('/blog/') else 'website'}"/><meta property="og:url" content="https://crypto-chat.rapport.tec.br{path}"/><meta property="og:image" content="https://crypto-chat.rapport.tec.br{img}"/>
<link rel="stylesheet" href="/css/i18n.css"/><link rel="stylesheet" href="/css/site.css"/><script src="/js/i18n.js" defer></script></head><body>{link('site.skip','#main','skip-link')}'''
def nav():
 return '''<header class="site-header"><div class="container wrap"><div class="header-row"><a class="brand" href="/"><img src="/favicon.png" alt="" width="44" height="44"/>Rapport Crypto Chat</a><nav class="nav">'''+''.join(link(k,url) for k,url in [('site.nav.features','/#recursos'),('site.nav.freedom','/#liberdade'),('site.nav.team','/#equipe'),('site.nav.pricing','/#precos')])+f'<a href="/blog">Blog</a>'+link('site.nav.support','/suporte')+old('home.cta.download','Baixar APK','a','href="/install" class="button"')+'</nav></div></div></header>'
def footer():
 return '''<footer class="site-footer"><div class="wrap"><div class="footer-grid"><a href="https://rapport.tec.br" target="_blank" rel="noopener noreferrer"><img class="footer-logo" src="/images/rapport-logo.png" alt="Rapport Tecnologia" width="180" height="180" loading="lazy"/></a><div>'''+t('site.footer.tagline','h3')+'''<div class="footer-links"><a href="/blog">Blog</a>'''+link('site.nav.support','/suporte')+old('home.p.stats.title','Estatísticas','a','href="/stats"')+'''<a href="/privacidade" data-i18n="privacy.title">Privacidade, soberania e liberdade</a></div></div><div class="socials"><a href="https://linkedin.com/in/carlosdelfino" aria-label="LinkedIn" target="_blank" rel="noopener noreferrer"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3a2 2 0 1 1 0 4 2 2 0 0 1 0-4M3 9h4v12H3zm6 0h4v2c1-2 6-3 7 1v9h-4v-8c0-2-3-2-3 0v8H9z"/></svg></a><a href="https://instagram.com/rapport.tecnologia" aria-label="Instagram" target="_blank" rel="noopener noreferrer"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="18" cy="6" r="1"/></svg></a></div></div><div class="copyright"><p data-i18n-html="common.footer">© 2026 <a href="https://rapport.tec.br">Rapport Tecnologia e Inovação</a>. Projeto em desenvolvimento.</p></div></div></footer></body></html>'''
def title(k,lead=None,level='h2'):return '<div class="section-head">'+t(k,level)+(t(lead,'p') if lead else '')+'</div>'
def cards(items):
 out='<div class="grid">'
 for a in items:
  k='blog.'+a['slug'];url='/blog/'+a['slug']
  out+=f'<article class="blog-card"><a href="{url}" tabindex="-1" aria-hidden="true"><img src="/images/editorial/{a["image"]}.webp" alt="" loading="lazy" width="1536" height="1024"/></a><div class="content"><h3>'+link(k+'.title',url)+'</h3>'+t(k+'.intro','p')+link('site.blog.read',url,'card-link')+'</div></article>'
 return out+'</div>'
def save(path,s):
 f=P/path/'index.html' if path else P/'index.html';f.parent.mkdir(parents=True,exist_ok=True);f.write_text(s.replace('><', '>\n<'))
# Keep the existing feature and API descriptions as editable reusable fragments.
original=(P/'index.html').read_text()
if not (C/'features.html').exists():
 fragment=original.split('<div class="features-grid">')[1].split('<h2 class="section-title" data-i18n="home.section.pages">')[0]
 fragment=fragment.rsplit('</div>',1)[0]
 fragment=fragment.replace('feature-card','card').replace('class="icon"','class="feature-icon"')
 (C/'features.html').write_text(fragment)
if not (C/'api.html').exists():
 (C/'api.html').write_text(original.split('<div class="api-list">')[1].split('<div class="footer">')[0].rsplit('</div>',1)[0])
s=head('Rapport Crypto Chat','home.meta.title','/','Chat, carteira e pagamentos com privacidade e soberania.','home.meta.desc')+nav()
s+='<main id="main"><section class="hero"><div class="wrap hero-grid"><div class="hero-copy">'+t('site.hero.eyebrow','p','class="eyebrow"')+t('site.hero.title','h1')+old('home.hero.tagline','Chat protegido e direto entre pessoas, sem servidor central armazenando seus dados e suas mensagens. Você tem soberania sobre seus dados e mensagens, com identidade baseada em carteira blockchain. Também é uma wallet de criptomoedas e sistema de pagamentos com criptoativos e escrow.','p')+old('home.hero.learnMore','Saiba mais clicando aqui','a','href="/privacidade"')+'<div class="actions">'+old('home.cta.download','Baixar APK','a','href="/install" class="button"')+old('home.cta.comandos','Tutorial de comandos','a','href="/comandos" class="button secondary"')+'</div>'+old('home.hero.subtagline','Sem cadastro. Sem rastreamento. Apenas você, sua carteira e a criptografia.','p')+'</div><div class="hero-art"><img src="/images/editorial/privacy.webp" alt="" fetchpriority="high" width="1536" height="1024"/><div class="hero-caption">'+t('site.freedom.communication')+'</div></div></div></section>'
s+='<div class="value-strip"><div class="wrap">'+''.join(link(k,url) for k,url in [('site.freedom.communication','/chat'),('site.freedom.identity','/wallet'),('site.pricing.tx','/escrow'),('site.nav.freedom','/privacidade')])+'</div></div>'
s+='<section class="section" id="recursos"><div class="wrap">'+title('site.features.title','site.features.lead')+'<div class="grid">'+(C/'features.html').read_text()+'</div><div class="resources">'+old('home.p.ajudar.title','Como ajudar','a','href="/ajudar"')+old('home.p.github.title','Código-fonte','a','href="https://github.com/carlosdelfino/rapport-crypto-p2p-chat"')+'</div></div></section>'
s+='<section class="section tint" id="liberdade"><div class="wrap">'+title('site.freedom.title','site.freedom.lead')+'<div class="grid">'
for k,img,url in [('communication','sovereignty','/blog/soberania-digital'),('identity','identity','/blog/identidade-autossoberana'),('finance','funds','/blog/fundos-cripto')]:s+=f'<article class="portfolio-card"><img src="/images/editorial/{img}.webp" alt="" loading="lazy" width="1536" height="1024"/>'+link('site.freedom.'+k,url)+'</article>'
s+='</div></div></section>'
# Reuse all three existing statistics renderers and the same API; never invent counters.
statspage=(P/'stats/index.html').read_text()
statsscript=statspage[statspage.index('    function esc(s)'):statspage.rindex('  </script>')]
statsscript=statsscript.replace("document.getElementById('stats-content').innerHTML =\n          '<p class=\"error\">' + esc(tt('stats.error')) + '</p>';", "['stats-content', 'financial-content', 'escrow-demand-content'].forEach(function(id) { document.getElementById(id).innerHTML = '<p class=\"error\">' + esc(tt('stats.error')) + '</p>'; });")
(P/'js/home-stats.js').write_text(statsscript)
s+='<section class="section stats-section" id="estatisticas"><div class="wrap">'+title('site.stats.title','site.stats.lead')+'<div id="stats-content">'+old('stats.loading','Carregando estatísticas…','p')+'</div><details class="stats-details" open><summary>'+old('stats.vol.title','Volume transacionado')+'</summary><div>'+old('stats.vol.desc','Total de cripto movimentado pelo app em cada moeda e rede, reportado de forma anônima a cada transação confirmada — nenhum endereço de carteira é coletado ou exibido. O volume demonstra o crescimento do app e seu impacto na economia cripto.','p')+'<div id="financial-content">'+old('stats.loadingFinancial','Carregando dados financeiros…','p')+'</div></div></details><details class="stats-details" open><summary>'+old('stats.esc.title','Demanda por escrow')+'</summary><div>'+old('stats.esc.desc','Pedidos de usuários por suporte a escrow em redes ainda sem contrato deployado.','p')+'<div id="escrow-demand-content">'+old('stats.loadingEscrow','Carregando pedidos de escrow…','p')+'</div></div></details><p>'+old('home.cta.stats','Ver estatísticas','a','href="/stats"')+'</p></div></section><script src="/js/home-stats.js" defer></script>'
s+='<section class="section" id="precos"><div class="wrap">'+title('site.pricing.title')+'<div class="grid">'
for name,price in [('chat','R$ 0'),('tx','0.10%'),('gas','↗')]:
 s+='<article class="card price-card '+('highlight' if name=='tx' else '')+'">'+t('site.pricing.'+name,'h3')+('<div class="price">'+(t('site.pricing.variable') if name=='gas' else price)+'</div>')+t('site.pricing.'+name+'desc','p')+(t('site.pricing.example','p') if name=='tx' else '')+link('site.nav.support','/suporte','button secondary')+'</article>'
s+='</div></div></section><section class="section tint" id="equipe"><div class="wrap">'+title('site.team.title')+'<div class="team"><a href="https://carlosdelfino.eti.br" target="_blank" rel="noopener noreferrer"><img src="/images/carlos-delfino-stand.jpg" alt="Carlos Delfino" width="340" height="340" loading="lazy"/></a><div><h3>Carlos Delfino</h3><p class="role">Founder / CEO / CTO</p>'+t('site.team.bio','p')+link('site.team.link','https://carlosdelfino.eti.br','button secondary')+'</div></div></div></section>'
s+='<section class="section" id="depoimentos"><div class="wrap">'+title('site.reviews.title')+t('site.reviews.note','p','class="review-note"')+'<div class="reviews-grid">'
people=[('Ana Souza','review-ana','site.review.ana'),('Lucas Oliveira','review-lucas','site.review.lucas')]+[(n,img,'site.review.'+str(i)) for i,(n,img,_) in enumerate(reviews,3)]
for name,img,key in people:s+='<article class="review">'+t(key,'blockquote')+f'<div class="review-person"><img src="/images/editorial/{img}.webp" alt="" loading="lazy" width="56" height="56"/><div><strong>{name}</strong>'+t('site.review.role','small')+'</div></div></article>'
s+='</div></div></section><section class="section tint"><div class="wrap">'+title('site.blog.title','site.blog.lead')+cards(articles[:3])+'<div class="actions" style="justify-content:center">'+link('site.blog.all','/blog','button secondary')+'</div></div></section><section class="cta-band"><div class="wrap cta-inner">'+t('site.cta.title','h2')+t('site.cta.desc','p')+old('home.cta.download','Baixar APK','a','href="/install" class="button"')+'</div></section><section class="section"><div class="wrap questions"><div>'+t('site.questions.title','h2')+t('site.questions.desc','p')+'</div>'+link('site.nav.support','/suporte','button')+'</div></section><details class="wrap api-details"><summary>API</summary><div class="api-list">'+(C/'api.html').read_text()+'</div></details></main>'+footer()
save('',s)
s=head(ui['site.blog.title'][0],'site.blog.title','/blog',ui['site.blog.lead'][0],'site.blog.lead')+nav()+'<main id="main" class="section"><div class="wrap">'+title('site.blog.title','site.blog.lead','h1')+cards(articles)+'</div></main>'+footer();save('blog',s)
for a in articles:
 k='blog.'+a['slug'];path='/blog/'+a['slug']
 s=head(a['pt-BR'][0],k+'.title',path,a['pt-BR'][1],k+'.intro','/images/editorial/'+a['image']+'.webp')+nav()+'<main id="main" class="wrap"><article><header class="article-header"><p class="eyebrow">'+link('site.blog.all','/blog')+'</p>'+t(k+'.title','h1')+t(k+'.intro','p')+t('site.blog.editorial','small')+'</header><img class="article-cover" src="/images/editorial/'+a['image']+'.webp" alt="" width="1536" height="1024" fetchpriority="high"/><div class="article-body">'+''.join(t(k+'.p'+str(i),'p') for i in [1,2,3])+t('site.blog.sources','h2')+f'<p><a href="{a["source"]}">{a["sourceLabel"]}</a></p>'+link('site.blog.all','/blog','button secondary')+'</div></article></main>'+footer();save('blog/'+a['slug'],s)
s=head(ui['site.support.title'][0],'site.support.title','/suporte',ui['site.questions.desc'][0],'site.questions.desc')+nav()+'<main id="main" class="section"><div class="wrap">'+title('site.support.title','site.questions.desc','h1')+'<div class="support-grid"><section class="card"><h2>Crypto Chat</h2>'+t('site.support.steps','p')+'<code class="support-address" dir="ltr">0x7010A4C4c189AB421028a622e2A2e623f432d18e</code>'+old('home.cta.download','Baixar APK','a','href="/install" class="button secondary"')+'</section><section class="card"><h2>WhatsApp</h2><p dir="ltr">+55 (85) 98520-5490</p>'+link('site.support.whatsapp','https://wa.me/5585985205490','button')+'</section></div></div></main>'+footer();save('suporte',s)
# Add new canonical routes to the existing sitemap.
f=P/'sitemap.xml';s=f.read_text()
for path in ['/blog','/suporte','/privacidade']+['/blog/'+a['slug'] for a in articles]:
 url='https://crypto-chat.rapport.tec.br'+path
 if '<loc>'+url+'</loc>' not in s:s=s.replace('</urlset>',f'  <url><loc>{url}</loc></url>\n</urlset>')
f.write_text(s)
print('Generated home, blog, 7 articles, support and 4 translation dictionaries.')
