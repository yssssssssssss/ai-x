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
  Tag,
  Typography,
} from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { useEffect, useState } from 'react';
import type {
  ExperienceAnalyzeResult,
  ExperienceModelProfile,
  ExperienceModelSelection,
} from '@experience-model-lab/core';
import { analyze, listModels } from '../lib/api.js';
import './styles.css';

const { Header, Sider, Content } = Layout;
const { Title, Paragraph, Text } = Typography;

const defaultQuery = '评估电商首页内容种草区是否提升用户参与、信任和转化意愿';

export const App = () => {
  const [query, setQuery] = useState(defaultQuery);
  const [models, setModels] = useState<ExperienceModelProfile[]>([]);
  const [result, setResult] = useState<ExperienceAnalyzeResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    listModels()
      .then(setModels)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const run = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setResult(await analyze({ query }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const selected = result?.selectedModels ?? [];
  const rejected = result?.rejectedModels ?? [];

  return (
    <ConfigProvider locale={zhCN} theme={{ token: { borderRadius: 14, colorPrimary: '#1677ff' } }}>
      <Layout className="app-shell">
        <Sider width={240} theme="light" className="app-shell-sider">
          <div className="app-shell-brand">
            <div className="app-shell-brand-kicker">Research OS</div>
            <div className="app-shell-brand-title">AI 用研分析系统</div>
          </div>
          <Menu
            selectedKeys={['experience']}
            mode="inline"
            items={[{ key: 'experience', label: '体验模型选型' }]}
          />
        </Sider>
        <Layout className="app-shell-main">
          <Header className="app-shell-header">
            <div className="app-shell-header-kicker">Workspace</div>
            <div className="app-shell-header-title">体验模型选型</div>
            <div className="app-shell-header-subtitle">
              输入研究问题，返回可解释的体验模型推荐、选型依据与问题模板
            </div>
          </Header>
          <Content className="app-shell-content">
            <div className="app-shell-content-inner">
              {/* ---------- 操作区 ---------- */}
              <Card className="page-card" title="发起选型">
                <Space direction="vertical" size={18} style={{ width: '100%' }}>
                  <div>
                    <Text type="secondary" style={{ fontWeight: 600 }}>研究问题</Text>
                    <Input.TextArea
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      rows={4}
                      style={{ marginTop: 8 }}
                      placeholder="例如：评估电商首页内容种草区是否提升用户参与、信任和转化意愿"
                    />
                  </div>
                  {models.length ? (
                    <div>
                      <Text type="secondary" style={{ fontWeight: 600 }}>模型目录（{models.length}）</Text>
                      <div className="exp-model-cloud" style={{ marginTop: 8 }}>
                        {models.map((m) => (
                          <div className="exp-model-chip" key={m.id}>
                            <strong>{m.name}</strong>
                            <span>{m.bestFor.slice(0, 2).join(' / ')}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  <Button
                    type="primary"
                    size="large"
                    loading={busy}
                    disabled={!query.trim()}
                    onClick={() => void run()}
                  >
                    开始选型
                  </Button>
                </Space>
              </Card>

              {error ? <Alert type="error" showIcon message="选型失败" description={error} /> : null}

              {/* ---------- 结果区 ---------- */}
              {result ? (
                <>
                  <div className="module-hero module-hero-experience">
                    <div className="module-hero-main">
                      <Text className="module-hero-kicker">Experience Model</Text>
                      <Title level={2} className="module-hero-title">
                        体验模型选型
                      </Title>
                      <Paragraph className="module-hero-description">
                        针对研究问题推荐体验模型、给出选型依据与配套问题模板。
                      </Paragraph>
                      <div className="module-hero-meta">
                        <Text className="module-hero-pill">{result.status}</Text>
                        <Text className="module-hero-pill">已选 {selected.length} 个模型</Text>
                        <Text className="module-hero-pill">问题模板 {result.questionTemplates.length}</Text>
                      </div>
                    </div>
                  </div>

                  {result.summary ? (
                    <Alert type="info" showIcon message="推荐概览" description={result.summary} />
                  ) : null}

                  {result.frameworkSummary ? (
                    <Card title="框架总结" className="page-card module-section-card">
                      <Paragraph style={{ marginBottom: 0 }}>{result.frameworkSummary}</Paragraph>
                    </Card>
                  ) : null}

                  {selected.length ? (
                    <Card title="推荐模型" className="page-card module-section-card">
                      <div className="exp-selected-grid">
                        {selected.map((m) => (
                          <ModelCard key={m.id} model={m} highlighted />
                        ))}
                      </div>
                    </Card>
                  ) : null}

                  {result.modelRationale.length || result.questionTemplates.length ? (
                    <div className="exp-two-col">
                      {result.modelRationale.length ? (
                        <Card title="选型依据" className="page-card module-section-card">
                          <List
                            size="small"
                            dataSource={result.modelRationale}
                            renderItem={(item) => <List.Item>{item}</List.Item>}
                          />
                        </Card>
                      ) : null}
                      {result.questionTemplates.length ? (
                        <Card title="问题模板" className="page-card module-section-card">
                          <List
                            size="small"
                            dataSource={result.questionTemplates}
                            renderItem={(item, index) => (
                              <List.Item>
                                <Space align="start">
                                  <Tag color="blue">{index + 1}</Tag>
                                  <Text>{item}</Text>
                                </Space>
                              </List.Item>
                            )}
                          />
                        </Card>
                      ) : null}
                    </div>
                  ) : null}

                  {result.evidenceChunks.length ? (
                    <Card title="证据溯源" className="page-card module-section-card">
                      <List
                        dataSource={result.evidenceChunks}
                        renderItem={(chunk) => (
                          <List.Item>
                            <Space direction="vertical" size={6} style={{ width: '100%' }}>
                              <Space wrap>
                                <Tag color="purple">{chunk.filename}</Tag>
                                <Text type="secondary">{chunk.source}</Text>
                              </Space>
                              {chunk.matchedTerms.length ? (
                                <Space wrap>
                                  {chunk.matchedTerms.map((term) => (
                                    <Tag key={term}>{term}</Tag>
                                  ))}
                                </Space>
                              ) : null}
                            </Space>
                          </List.Item>
                        )}
                      />
                    </Card>
                  ) : null}

                  {rejected.length ? (
                    <Card title="未选用模型" className="page-card module-section-card">
                      <div className="exp-selected-grid">
                        {rejected.map((m) => (
                          <ModelCard key={m.id} model={m} />
                        ))}
                      </div>
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
                <Empty description="填写研究问题并点击「开始选型」查看结果" />
              )}
            </div>
          </Content>
        </Layout>
      </Layout>
    </ConfigProvider>
  );
};

function ModelCard({ model, highlighted }: { model: ExperienceModelSelection; highlighted?: boolean }) {
  return (
    <Card
      type="inner"
      className={highlighted ? 'exp-selected-card' : undefined}
      title={model.name}
      extra={<Tag color={highlighted ? 'blue' : 'default'}>匹配 {model.score}</Tag>}
    >
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        {model.reasons.length ? (
          <List
            size="small"
            dataSource={model.reasons}
            renderItem={(item) => <List.Item>{item}</List.Item>}
          />
        ) : null}
        <Text type="secondary" style={{ fontSize: 12 }}>{model.filename}</Text>
      </Space>
    </Card>
  );
}
