import Link from 'next/link';

import { NoraLogo } from '@/components/brand/nora-logo';
import { ShaderOrb } from '@/components/brand/shader-orb';

function Check({ size = 14, strokeWidth = 2.4 }: { size?: number; strokeWidth?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

// ── How it works ──
export function LandingHowItWorks() {
  return (
    <section id="como-funciona">
      <div className="container">
        <div style={{ maxWidth: 720 }}>
          <div className="section-label">Como funciona</div>
          <h2 className="section-title">Da reunião aos próximos passos.</h2>
          <p className="section-subtitle">
            Importe uma transcrição ou capture a reunião pelo Desktop para Windows.
          </p>
        </div>

        <div className="steps-grid">
          <div className="step-card">
            <span className="step-num">01 · Suba</span>
            <h3>Importe ou capture a reunião.</h3>
            <p>.txt, .vtt, .srt — ou capture áudio do sistema no app Desktop para Windows.</p>
            <div className="step-visual">
              <div className="mock-file">
                <div className="mock-file-icon">
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                </div>
                <span className="mock-file-name">reuniao-exemplo.vtt</span>
                <span className="mock-file-size">Exemplo</span>
              </div>
            </div>
          </div>

          <div className="step-card">
            <span className="step-num">02 · Nora processa</span>
            <h3>Análise estruturada.</h3>
            <p>
              O PII Shield mascara dados pessoais no texto antes da análise. A Nora extrai resumo,
              decisões e tarefas.
            </p>
            <div className="step-visual">
              <div className="mock-orb-row">
                <div className="mock-orb-pulse">
                  <ShaderOrb size={36} speed={1.6} intensity={1} />
                </div>
                <div>
                  <div className="text">Detectando action items…</div>
                  <div className="sub">Exemplo de processamento</div>
                </div>
              </div>
            </div>
          </div>

          <div className="step-card">
            <span className="step-num">03 · Você recebe</span>
            <h3>Consulte e acompanhe.</h3>
            <p>
              Consulte as fontes, acompanhe tarefas e use os fluxos para enviar resultados às
              ferramentas conectadas.
            </p>
            <div className="step-visual">
              <div className="mock-summary">
                <h5>Resumo</h5>
                <div className="mock-line w90" />
                <div className="mock-line w70" />
                <div className="mock-line w50" style={{ marginBottom: 0 }} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ── Privacy ──
const PROMISES = [
  {
    title: 'Isolamento por workspace',
    body: 'Reuniões e análises ficam vinculadas ao workspace. A API verifica o acesso a cada recurso; o banco aplica isolamento entre organizações.',
    icon: (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
      </svg>
    ),
  },
  {
    title: 'Texto protegido antes da análise',
    body: 'O PII Shield identifica e mascara tipos de dados pessoais no texto, incluindo CPF, CNPJ, e-mail, telefone, cartão, nomes e endereços.',
    icon: (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="9" />
        <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
      </svg>
    ),
  },
  {
    title: 'Exclusão definitiva',
    body: 'A exclusão definitiva remove a reunião, sua transcrição, participantes e análise. Ela é uma ação separada da remoção comum de uma reunião.',
    icon: (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 6h18" />
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      </svg>
    ),
  },
  {
    title: 'Trilha de auditoria',
    body: 'No Enterprise, administradores consultam eventos de autenticação e alterações de acesso, com autor, alvo e horário.',
    icon: (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M9 11l3 3L22 4" />
        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
      </svg>
    ),
  },
];

export function LandingPrivacy() {
  return (
    <section id="privacidade" className="privacy">
      <div className="container">
        <div className="privacy-head">
          <div className="section-label">Privacidade</div>
          <h2 className="section-title">Dados, acesso e exclusão.</h2>
          <p className="section-subtitle">
            O mascaramento protege o texto enviado para análise. No Desktop, o áudio é enviado ao
            provedor de transcrição antes desse tratamento.
          </p>
        </div>

        <div className="privacy-grid">
          {PROMISES.map((p) => (
            <div className="privacy-card" key={p.title}>
              <div className="privacy-card-icon">{p.icon}</div>
              <h3>{p.title}</h3>
              <p>{p.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── Pricing ──
const CORE_FEATURES = [
  'Resumos, decisões e action items',
  'Chat com fontes das reuniões',
  'Projetos, participantes e acompanhamento de tarefas',
  'Productivity Score com objetivo definido por você',
  'Captura e transcrição no Desktop para Windows',
  'Relatórios em Markdown e PDF',
  'Integrações OAuth e fluxos de automação',
  'Servidor MCP para consultas somente leitura',
];

const ENTERPRISE_FEATURES = [
  'Recursos do Core no workspace da equipe',
  'Visão executiva de riscos, decisões e pendências',
  'Diretório de usuários, grupos e convites',
  'Policies, limites de permissão e auditoria',
  'Contexto da empresa, produtos e concorrentes',
  'Histórico de versões do contexto',
  'Customer Confidence por reunião',
  'Restrição de convites por domínio corporativo',
];

export function LandingPricing() {
  return (
    <section id="planos" className="tight">
      <div className="container">
        <div style={{ maxWidth: 720 }}>
          <div className="section-label">Planos</div>
          <h2 className="section-title">Core para você. Enterprise para sua equipe.</h2>
          <p className="section-subtitle">
            O cadastro cria um workspace Core. Os recursos Enterprise ficam em workspaces
            habilitados, com acesso por convite.
          </p>
        </div>

        <div className="pricing-grid">
          <div className="pricing-card">
            <div className="pricing-head">
              <span className="badge">Core</span>
              <h3>Copiloto pessoal</h3>
              <p>Reuniões, perguntas e tarefas do dia a dia.</p>
            </div>
            <div className="pricing-price">
              <span className="num">Grátis</span>
              <span className="unit">cadastro individual</span>
            </div>
            <ul className="pricing-features">
              {CORE_FEATURES.map((f) => (
                <li key={f}>
                  <Check />
                  {f}
                </li>
              ))}
            </ul>
            <Link
              href="/auth/signup"
              className="btn btn-ghost btn-lg"
              style={{ justifyContent: 'center' }}
            >
              Começar grátis
            </Link>
          </div>

          <div className="pricing-card highlighted">
            <div className="pricing-head">
              <span className="badge ent">Enterprise</span>
              <h3>Workspace de equipe</h3>
              <p>Contexto compartilhado e gestão de acesso.</p>
            </div>
            <div className="pricing-price">
              <span className="num">Por convite</span>
              <span className="unit">workspace Enterprise</span>
            </div>
            <ul className="pricing-features">
              {ENTERPRISE_FEATURES.map((feature) => (
                <li key={feature}>
                  <Check />
                  {feature}
                </li>
              ))}
            </ul>
            <Link
              href="/auth/login?next=%2Fenterprise"
              className="btn btn-primary btn-lg"
              style={{ justifyContent: 'center' }}
            >
              Entrar no workspace
            </Link>
            <p className="pricing-note">
              Para usuários de um workspace habilitado. Não há contratação ou cobrança pela
              plataforma.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

// ── FAQ ──
const FAQS = [
  {
    q: 'Como a Nora recebe uma reunião?',
    a: 'Você pode importar uma transcrição em .txt, .vtt ou .srt. No Desktop para Windows, o app captura o áudio e o envia diretamente ao provedor de transcrição; a infraestrutura da Nora recebe o texto. Não há upload de arquivos de áudio ou vídeo.',
  },
  {
    q: 'Qual é a diferença entre Core e Enterprise?',
    a: 'Core reúne captura, reuniões, chat, projetos e tarefas. Enterprise acrescenta visão executiva, usuários e convites, grupos e policies, contexto da empresa e Customer Confidence por reunião. O acesso a cada recurso também depende das permissões do usuário.',
  },
  {
    q: 'Como entro em um workspace Enterprise?',
    a: 'Um administrador de um workspace Enterprise envia um convite por e-mail e define seus grupos de acesso. O cadastro público cria um workspace Core; não há contratação ou ativação automática de Enterprise pelo site.',
  },
  {
    q: 'Como funciona o tratamento de dados pessoais?',
    a: 'O PII Shield mascara tipos de dados pessoais na transcrição antes da análise por IA. O áudio usado para transcrição é enviado ao provedor externo antes desse tratamento. No chat, a ocultação de nomes ainda é uma limitação conhecida. Esses controles não representam certificação de conformidade com a LGPD.',
  },
  {
    q: 'Funciona com Google Meet, Zoom e Teams?',
    a: 'Você pode importar uma transcrição exportada por essas ferramentas, nos formatos aceitos, ou capturar o áudio do sistema pelo Desktop para Windows. A captura não depende de um bot na chamada.',
  },
  {
    q: 'Posso integrar com minhas ferramentas?',
    a: 'Os conectores OAuth e os fluxos enviam resultados às contas conectadas. O servidor MCP funciona no sentido inverso: permite que um agente consulte dados da Nora, somente para leitura e respeitando as permissões do usuário. Customer Confidence fica restrito ao Enterprise.',
  },
  {
    q: 'Posso exportar ou excluir uma reunião?',
    a: 'Cada reunião pode ser exportada em Markdown ou aberta como relatório para impressão e PDF. A exclusão definitiva remove também a transcrição e a análise, mediante confirmação. A remoção comum e a exclusão definitiva são ações distintas.',
  },
];

export function LandingFAQ() {
  return (
    <section id="faq">
      <div className="container">
        <div style={{ maxWidth: 720 }}>
          <div className="section-label">FAQ</div>
          <h2 className="section-title">Perguntas que costumam aparecer.</h2>
        </div>
        <div className="faq-list">
          {FAQS.map((f) => (
            <details className="faq-item" key={f.q}>
              <summary>
                <span>{f.q}</span>
                <span className="plus">+</span>
              </summary>
              <div className="answer">{f.a}</div>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── Final CTA ──
export function LandingFinalCTA() {
  return (
    <section id="cta" style={{ padding: '20px 0 80px' }}>
      <div className="container">
        <div className="cta">
          <div className="cta-inner">
            <h2>Sua próxima reunião pode terminar com o resumo pronto.</h2>
            <p>Importe uma transcrição e consulte decisões, fontes e próximos passos.</p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
              <Link href="/auth/signup" className="btn btn-primary btn-lg">
                Começar grátis
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>
              </Link>
              {/* There is nobody to schedule a demo with; the demo that exists is the
                  interactive section further up the page. */}
              <a href="#demo" className="btn btn-ghost btn-lg">
                Ver a demonstração
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ── Footer ──
const REPO_URL = 'https://github.com/5forzin/nora';

export function LandingFooter() {
  return (
    <footer>
      <div className="container">
        <div className="footer-inner">
          <div className="footer-brand">
            <NoraLogo size={22} animate={false} />
            <p>Reuniões, decisões e próximos passos.</p>
          </div>
          <div className="footer-col">
            <h4>Produto</h4>
            <ul>
              <li>
                <a href="#produto">Recursos</a>
              </li>
              <li>
                <a href="#planos">Planos</a>
              </li>
              <li>
                <a href="#demo">Demonstração</a>
              </li>
              <li>
                <a href="#faq">FAQ</a>
              </li>
            </ul>
          </div>
          {/* Every link here points at something that exists. The old "Empresa" column
              (Sobre, Carreiras, Blog, Contato) and the Termos/Status entries were
              href="#" placeholders for pages and documents that were never written. */}
          <div className="footer-col">
            <h4>Projeto</h4>
            <ul>
              <li>
                <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
                  Repositório
                </a>
              </li>
              <li>
                <a
                  href={`${REPO_URL}/tree/main/docs/adr`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  ADRs
                </a>
              </li>
            </ul>
          </div>
          <div className="footer-col">
            <h4>Recursos</h4>
            <ul>
              <li>
                <a href={`${REPO_URL}/tree/main/docs`} target="_blank" rel="noopener noreferrer">
                  Documentação
                </a>
              </li>
              <li>
                <a href="#privacidade">Privacidade</a>
              </li>
            </ul>
          </div>
        </div>
        <div className="footer-meta">
          <span>© 2026 Nora · Construído em São Paulo</span>
          <span>Código e decisões de arquitetura abertos no repositório</span>
        </div>
      </div>
    </footer>
  );
}
