import {
  Alert,
  Button,
  Card,
  Col,
  ConfigProvider,
  Empty,
  Input,
  Layout,
  List,
  Menu,
  Row,
  Space,
  Statistic,
  Tag,
  Typography,
} from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { useEffect, useState } from 'react';
import type { PersonaProfile, PersonaReview, VirtualUserSimulateResult } from '@virtual-user-lab/core';
import { listPersonas, simulate } from '../lib/api.js';
import './styles.css';

const { Header, Sider, Content } = Layout;
const { Title, Paragraph, Text } = Typography;

const defaultScenario = '评估电商首页内容种草区是否能提升用户参与、信任和转化意愿';

const stanceColorMap: Record<string, string> = {
  positive: 'green',
  mixed: 'blue',
  negative: 'red',
};

const scoreLabelMap: Record<string, string> = {
  usability: '易用性',
  attractiveness: '吸引力',
  trust: '信任',
  conversionIntent: '转化意愿',
  emotionalResonance: '情感共鸣',
};

export const App = () => {
  const [scenario, setScenario] = useState(defaultScenario);
  const [personas, setPersonas] = useState<PersonaProfile[]>([]);
  const [result, setResult] = useState<VirtualUserSimulateResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    listPersonas()
      .then(setPersonas)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const run = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setResult(await simulate({ scenario }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const reviews = result?.reviews ?? [];
  const aggregate = result?.aggregate;
  const hasAggregate = Boolean(
    aggregate?.sharedPainPoints.length ||
      aggregate?.sharedHighlights.length ||
      aggregate?.divergences.length ||
      aggregate?.churnRisks.length,
  );

  return (
    <ConfigProvider locale={zhCN} theme={{ token: { borderRadius: 14, colorPrimary: '#722ed1' } }}>
      <Layout className="app-shell">
        <Sider width={240} theme="light" className="app-shell-sider">
          <div className="app-shell-brand">
            <div className="app-shell-brand-kicker">Research OS</div>
            <div className="app-shell-brand-title">AI 用研分析系统</div>
          </div>
          <Menu
            selectedKeys={['persona']}
            mode="inline"
            items={[{ key: 'persona', label: '模拟用户' }]}
          />
        </Sider>
        <Layout className="app-shell-main">
          <Header className="app-shell-header">
            <div className="app-shell-header-kicker">Workspace</div>
            <div className="app-shell-header-title">模拟用户</div>
            <div className="app-shell-header-subtitle">
              用虚拟 Persona 做方案初筛，输出模拟反馈和待验证假设
            </div>
          </Header>
          <Content className="app-shell-content">
            <div className="app-shell-content-inner">
              {/* ---------- 操作区 ---------- */}
              <Card className="page-card" title="发起模拟">
                <Space direction="vertical" size={18} style={{ width: '100%' }}>
                  <div>
                    <Text type="secondary" style={{ fontWeight: 600 }}>模拟场景</Text>
                    <Input.TextArea
                      value={scenario}
                      onChange={(e) => setScenario(e.target.value)}
                      rows={3}
                      style={{ marginTop: 8 }}
                      placeholder="例如：评估电商首页内容种草区是否能提升用户参与、信任和转化意愿"
                    />
                  </div>
                  {personas.length ? (
                    <div>
                      <Text type="secondary" style={{ fontWeight: 600 }}>内置 Persona</Text>
                      <div className="persona-chip-cloud" style={{ marginTop: 8 }}>
                        {personas.map((p) => (
                          <div className="persona-chip" key={p.id}>
                            <strong>{p.name}</strong>
                            <span>{p.type}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  <Button
                    type="primary"
                    size="large"
                    loading={busy}
                    disabled={!scenario.trim()}
                    onClick={() => void run()}
                  >
                    开始模拟
                  </Button>
                </Space>
              </Card>

              {error ? <Alert type="error" showIcon message="模拟失败" description={error} /> : null}

              {/* ---------- 结果区 ---------- */}
              {result ? (
                <>
                  <div className="module-hero module-hero-persona">
                    <div className="module-hero-main">
                      <Text className="module-hero-kicker">Persona Sandbox</Text>
                      <Title level={2} className="module-hero-title">
                        模拟用户
                      </Title>
                      <Paragraph className="module-hero-description">
                        看用了哪些人群原型、数字人怎么打分、共性痛点和分歧在哪里。
                      </Paragraph>
                      <div className="module-hero-meta">
                        <Text className="module-hero-pill">虚拟 Persona 初筛</Text>
                        <Text className="module-hero-pill">模拟反馈 · 非真实证据</Text>
                        <Text className="module-hero-pill">{result.status}</Text>
                      </div>
                    </div>
                  </div>

                  <Alert type="warning" showIcon message="模拟结果不是真实用户研究证据，仅用于方案初筛与假设生成。" />

                  {result.summary ? (
                    <Alert type="info" showIcon message="模拟反馈概览" description={result.summary} />
                  ) : null}

                  <Row gutter={16}>
                    <Col span={8}>
                      <Card className="page-card"><Statistic title="Persona 数量" value={reviews.length} /></Card>
                    </Col>
                    <Col span={8}>
                      <Card className="page-card"><Statistic title="共性痛点" value={aggregate?.sharedPainPoints.length ?? 0} /></Card>
                    </Col>
                    <Col span={8}>
                      <Card className="page-card"><Statistic title="主要分歧" value={aggregate?.divergences.length ?? 0} /></Card>
                    </Col>
                  </Row>

                  {hasAggregate ? (
                    <Card title="共性总结" className="page-card module-section-card">
                      <Space direction="vertical" size={16} style={{ width: '100%' }}>
                        {aggregate?.sharedPainPoints.length ? (
                          <AggregateBlock title="共性痛点" items={aggregate.sharedPainPoints} />
                        ) : null}
                        {aggregate?.sharedHighlights.length ? (
                          <AggregateBlock title="共性亮点" items={aggregate.sharedHighlights} />
                        ) : null}
                        {aggregate?.divergences.length ? (
                          <AggregateBlock title="主要分歧" items={aggregate.divergences} />
                        ) : null}
                        {aggregate?.churnRisks.length ? (
                          <AggregateBlock title="流失风险" items={aggregate.churnRisks} />
                        ) : null}
                      </Space>
                    </Card>
                  ) : null}

                  {reviews.length ? (
                    <Card title="各自回答" className="page-card module-section-card">
                      <div className="persona-review-grid">
                        {reviews.map((review) => (
                          <ReviewCard key={review.profileId} review={review} />
                        ))}
                      </div>
                    </Card>
                  ) : null}

                  {result.recommendations.length ? (
                    <Card title="改进建议" className="page-card module-section-card">
                      <List
                        size="small"
                        dataSource={result.recommendations}
                        renderItem={(item) => <List.Item>{item}</List.Item>}
                      />
                    </Card>
                  ) : null}

                  {result.boundaryNotes.length || result.warnings.length ? (
                    <Row gutter={16}>
                      <Col span={12}>
                        {result.boundaryNotes.length ? (
                          <Card title="边界说明" className="page-card module-section-card">
                            <List
                              size="small"
                              dataSource={result.boundaryNotes}
                              renderItem={(item) => <List.Item>{item}</List.Item>}
                            />
                          </Card>
                        ) : null}
                      </Col>
                      <Col span={12}>
                        {result.warnings.length ? (
                          <Card title="提醒" className="page-card module-section-card">
                            <List
                              size="small"
                              dataSource={result.warnings}
                              renderItem={(item) => <List.Item>{item}</List.Item>}
                            />
                          </Card>
                        ) : null}
                      </Col>
                    </Row>
                  ) : null}
                </>
              ) : (
                <Empty description="填写模拟场景并点击「开始模拟」查看结果" />
              )}
            </div>
          </Content>
        </Layout>
      </Layout>
    </ConfigProvider>
  );
};

function AggregateBlock({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <Paragraph strong style={{ marginBottom: 8 }}>{title}</Paragraph>
      <List size="small" dataSource={items} renderItem={(item) => <List.Item>{item}</List.Item>} />
    </div>
  );
}

function ReviewCard({ review }: { review: PersonaReview }) {
  const scoreEntries = Object.entries(review.scores).filter(
    (entry): entry is [string, number] => entry[1] !== undefined,
  );
  return (
    <Card
      type="inner"
      className="persona-review-card"
      title={`${review.personaName} · ${review.personaType}`}
      extra={<Tag color={stanceColorMap[review.stance] || 'default'}>{review.stance}</Tag>}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Tag color="green">总体评分 {review.overallScore}</Tag>
        <Paragraph style={{ marginBottom: 0 }}>
          <Text strong>第一印象：</Text>
          {review.firstImpression}
        </Paragraph>
        <Paragraph style={{ marginBottom: 0 }}>
          <Text strong>详细体验：</Text>
          {review.detailedExperience}
        </Paragraph>
        {scoreEntries.length ? (
          <Space wrap>
            {scoreEntries.map(([key, value]) => (
              <Tag key={key}>{scoreLabelMap[key] ?? key}：{value}</Tag>
            ))}
          </Space>
        ) : null}
        {review.topChangeRequest ? (
          <Alert type="warning" showIcon message={`最想改的点：${review.topChangeRequest}`} />
        ) : null}
      </Space>
    </Card>
  );
}
